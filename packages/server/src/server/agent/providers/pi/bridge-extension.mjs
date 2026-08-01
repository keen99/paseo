/**
 * Paseo Pi Live Bridge — pi extension.
 *
 * Copy/install into ~/.pi/agent/extensions/ (or load via `pi -e`).
 * Runs INSIDE live pi process. Opens unix socket (cwd-based path).
 * Streams agent events OUT to attached clients. Receives prompts/steers IN
 * and injects into the LIVE session via pi.sendUserMessage().
 *
 * This is the live-share counterpart to Paseo's attach-mode client
 * (packages/server/src/server/agent/providers/pi/bridge-attach.ts).
 *
 * Protocol: JSONL over a unix domain socket.
 *   OUT {"dir":"out","type":"hello","state":{...}}      (on client connect)
 *   OUT {"dir":"out","type":"state","state":{...}}      (state changes)
 *   OUT {"dir":"out","type":"event","event":{"type":<evt>,"data":<event>}}
 *   OUT {"dir":"out","type":"messages","messages":[...]}
 *   OUT {"dir":"out","type":"error","error":"..."}
 *   IN  {"dir":"in","type":"prompt","message":"..."[,"images":[...]]}
 *   IN  {"dir":"in","type":"steer","message":"..."[, ...]}  (queues while streaming)
 *   IN  {"dir":"in","type":"abort"}
 *   IN  {"dir":"in","type":"get_state"}
 *   IN  {"dir":"in","type":"get_messages"}
 *
 * Socket path: /tmp/paseo-pi-bridge-<cwd-slug>.sock
 *
 * Set PASEO_BRIDGE_DEBUG=1 to enable verbose stderr logging.
 */

import { createServer } from "node:net";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DEBUG = true;
const DEBUG_LOG_PATH = "/tmp/paseo-pi-bridge.log";

function formatLogValue(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value, jsonReplacer);
}

function log(...args) {
  if (!DEBUG) return;
  const text = args.map(formatLogValue).join(" ");
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `${new Date().toISOString()} pid=${process.pid} [paseo-bridge] ${text}\n`,
      "utf8",
    );
  } catch {
    // Debug logging must never disrupt pi TUI.
  }
}

const COMMAND_MODE_KEY = Symbol.for("paseo.pi.bridge.interactiveMode");
const COMMAND_OUTPUT_KEY = Symbol.for("paseo.pi.bridge.commandOutput");
const COMMAND_ACTIVE_KEY = Symbol.for("paseo.pi.bridge.commandActive");
let commandPatchInstalled = false;
let InteractiveMode;

async function installCommandDispatcherPatch() {
  if (commandPatchInstalled) return;
  try {
    const piRoot = require
      .resolve("@earendil-works/pi-coding-agent")
      .replace(/\/dist\/.*$/, "");
    const module = await import(
      join(piRoot, "dist", "modes", "interactive", "interactive-mode.js")
    );
    InteractiveMode = module.InteractiveMode;
    const proto = InteractiveMode?.prototype;
    const current = proto?.setExtensionStatus;
    if (typeof current !== "function") {
      throw new Error("InteractiveMode.setExtensionStatus unavailable");
    }
    if (!current.__paseoBridgeCapture) {
      const original = current.__paseoBridgeOriginal ?? current;
      const wrapped = function (...args) {
        globalThis[COMMAND_MODE_KEY] = this;
        return original.apply(this, args);
      };
      wrapped.__paseoBridgeCapture = true;
      wrapped.__paseoBridgeOriginal = original;
      proto.setExtensionStatus = wrapped;
    }

    for (const [method, level] of [
      ["showStatus", "info"],
      ["showWarning", "warning"],
      ["showError", "error"],
    ]) {
      const outputCurrent = proto[method];
      if (typeof outputCurrent !== "function" || outputCurrent.__paseoBridgeCapture) continue;
      const outputOriginal = outputCurrent.__paseoBridgeOriginal ?? outputCurrent;
      const outputWrapped = function (message, ...args) {
        if (globalThis[COMMAND_ACTIVE_KEY]) {
          globalThis[COMMAND_OUTPUT_KEY]?.(message, level);
        }
        return outputOriginal.call(this, message, ...args);
      };
      outputWrapped.__paseoBridgeCapture = true;
      outputWrapped.__paseoBridgeOriginal = outputOriginal;
      proto[method] = outputWrapped;
    }

    commandPatchInstalled = true;
    log("interactive command dispatcher patch installed");
  } catch (error) {
    log("interactive command dispatcher patch failed:", error);
  }
}

function installCommandUiOutputPatch(ctx) {
  const ui = ctx?.ui;
  const current = ui?.notify;
  if (typeof current !== "function" || current.__paseoBridgeCapture) return;
  const original = current.__paseoBridgeOriginal ?? current;
  const wrapped = function (message, level, ...args) {
    if (globalThis[COMMAND_ACTIVE_KEY]) {
      globalThis[COMMAND_OUTPUT_KEY]?.(message, level ?? "info");
    }
    return original.call(this, message, level, ...args);
  };
  wrapped.__paseoBridgeCapture = true;
  wrapped.__paseoBridgeOriginal = original;
  ui.notify = wrapped;
  log("extension UI notify patch installed");
}

async function dispatchSlashCommand(text) {
  const mode = globalThis[COMMAND_MODE_KEY];
  const submit = mode?.editor?.onSubmit ?? mode?.defaultEditor?.onSubmit;
  if (typeof submit !== "function") {
    throw new Error("Pi interactive command dispatcher unavailable");
  }
  globalThis[COMMAND_ACTIVE_KEY] = true;
  try {
    await submit(text);
  } finally {
    globalThis[COMMAND_ACTIVE_KEY] = false;
  }
  return mode;
}

function socketPathFor(cwd) {
  const slug = String(cwd || "default")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
  return `/tmp/paseo-pi-bridge-${slug}.sock`;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

export default function paseoPiBridge(pi) {
  log("factory called, cwd=", process.cwd(), "debug=", DEBUG);
  const clients = new Set();
  let extensionContext = null;
  let listening = false;
  const registryKey = Symbol.for("paseo.pi.bridge.server");

  const setBridgeStatus = (text) => {
    try {
      extensionContext?.ui?.setStatus?.("paseo-bridge", text);
    } catch (error) {
      log("setStatus failed:", error?.message);
    }
  };
  const state = {
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    cwd: process.cwd(),
    isStreaming: false,
  };

  const broadcast = (obj) => {
    const line = JSON.stringify(obj, jsonReplacer);
    for (const sock of clients) {
      try {
        sock.write(line + "\n");
      } catch (e) {
        log("write failed, dropping client:", e?.message);
        clients.delete(sock);
      }
    }
  };
  const sendState = () =>
    broadcast({ dir: "out", type: "state", state: { ...state } });

  let lastCommandOutput = { text: "", at: 0 };
  const ansiEscapePattern = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");
  const commandOutput = (message, type) => {
    const text = String(message ?? "").replace(ansiEscapePattern, "").trim();
    const now = Date.now();
    if (text && (text !== lastCommandOutput.text || now - lastCommandOutput.at > 100)) {
      lastCommandOutput = { text, at: now };
      log("command output:", type, text.slice(0, 160));
      broadcast({
        dir: "out",
        type: "event",
        event: { type: "command_output", data: { text, level: type } },
      });
    }
  };
  globalThis[COMMAND_OUTPUT_KEY] = commandOutput;

  const handleInbound = async (msg) => {
    if (msg.dir !== "in") return;
    log("inbound:", msg.type);
    switch (msg.type) {
      case "prompt": {
        const message = msg.message ?? "";
        if (message.trimStart().startsWith("/")) {
          await dispatchSlashCommand(message.trim());
          if (!state.isStreaming) {
            broadcast({
              dir: "out",
              type: "event",
              event: { type: "agent_end", data: { messages: [] } },
            });
          }
        } else {
          await pi.sendUserMessage(message, {
            images: msg.images,
            ...(state.isStreaming ? { deliverAs: "followUp" } : {}),
          });
        }
        break;
      }
      case "steer": {
        const message = msg.message ?? "";
        if (message.trimStart().startsWith("/")) {
          await dispatchSlashCommand(message.trim());
          if (!state.isStreaming) {
            broadcast({
              dir: "out",
              type: "event",
              event: { type: "agent_end", data: { messages: [] } },
            });
          }
        } else {
          await pi.sendUserMessage(message, {
            images: msg.images,
            deliverAs: "steer",
          });
        }
        break;
      }
      case "abort":
        await pi.abort?.();
        break;
      case "get_state":
        sendState();
        break;
      case "get_messages":
        broadcast({
          dir: "out",
          type: "messages",
          messages: extensionContext?.sessionManager?.buildSessionContext?.().messages ?? [],
        });
        break;
      default:
        log("unknown inbound type:", msg.type);
        break;
    }
  };

  const sockPath = socketPathFor(state.cwd);

  const server = createServer((sock) => {
    clients.add(sock);
    log("client connected, total=", clients.size);
    setBridgeStatus(`Paseo bridge: live (${clients.size})`);
    sock.setEncoding("utf8");
    sock.write(
      JSON.stringify({ dir: "out", type: "hello", state: { ...state } }, jsonReplacer) + "\n",
    );
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (e) {
          log("bad json:", e?.message);
          continue;
        }
        handleInbound(parsed).catch((error) => {
          log("inbound handler error:", error?.message);
          broadcast({
            dir: "out",
            type: "error",
            error: String(error?.message ?? error),
          });
        });
      }
    });
    sock.on("close", () => {
      clients.delete(sock);
      log("client closed, remaining=", clients.size);
      setBridgeStatus(
        clients.size > 0 ? `Paseo bridge: live (${clients.size})` : "Paseo bridge: idle",
      );
    });
    sock.on("error", (e) => { log("client sock err:", e?.message); clients.delete(sock); });
  });

  server.on("error", (e) => {
    listening = false;
    log("server error:", e?.message);
    setBridgeStatus(`Paseo bridge error: ${e?.code ?? e?.message ?? "unknown"}`);
  });

  const listen = () => {
    if (existsSync(sockPath)) {
      log("removing stale sock:", sockPath);
      try { unlinkSync(sockPath); } catch (e) { log("unlink failed:", e?.message); }
    }
    server.listen(sockPath, () => {
      listening = true;
      log("listening:", sockPath);
      setBridgeStatus("Paseo bridge: idle");
    });
  };

  const heartbeatTimer = setInterval(() => {
    if (clients.size === 0) return;
    broadcast({
      dir: "out",
      type: "event",
      event: { type: "live_heartbeat", data: { at: new Date().toISOString() } },
    });
  }, 2_000);
  heartbeatTimer.unref?.();

  const previous = globalThis[registryKey];
  globalThis[registryKey] = { server, clients, heartbeatTimer };
  if (previous?.server) {
    log("replacing bridge from previous extension load");
    clearInterval(previous.heartbeatTimer);
    for (const client of previous.clients ?? []) client.destroy();
    try {
      previous.server.close(listen);
    } catch {
      listen();
    }
  } else {
    listen();
  }

  process.on("exit", () => {
    clearInterval(heartbeatTimer);
    log("exit, closing server");
    try {
      server.close();
    } catch {
      // ignore
    }
  });

  pi.on("session_start", async (event, ctx) => {
    extensionContext = ctx;
    await installCommandDispatcherPatch();
    installCommandUiOutputPatch(ctx);
    if (listening) {
      setBridgeStatus(
        clients.size > 0 ? `Paseo bridge: live (${clients.size})` : "Paseo bridge: idle",
      );
    }
    const sm = ctx?.sessionManager;
    if (sm) {
      state.sessionFile = sm.getSessionFile?.() ?? sm.sessionFile ?? null;
      state.sessionId = sm.getSessionId?.() ?? sm.sessionId ?? null;
      state.sessionName = sm.getSessionName?.() ?? sm.sessionName ?? null;
      log("session_start:", state.sessionId, state.sessionFile);
    }
    sendState();
    broadcast({ dir: "out", type: "event", event: { type: "session_start", data: event } });
  });

  pi.on("agent_start", async (event) => {
    state.isStreaming = true;
    log("agent_start");
    sendState();
    broadcast({ dir: "out", type: "event", event: { type: "agent_start", data: event } });
  });
  pi.on("agent_end", async (event) => {
    state.isStreaming = false;
    log("agent_end");
    sendState();
    broadcast({ dir: "out", type: "event", event: { type: "agent_end", data: event } });
  });

  for (const evt of [
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "message_update",
    "tool_execution_start",
    "tool_execution_update",
    "tool_call",
    "tool_result",
    "tool_execution_end",
    "compaction_start",
    "session_compact",
  ]) {
    pi.on(evt, async (event) => {
      broadcast({ dir: "out", type: "event", event: { type: evt, data: event } });
    });
  }

  pi.on("session_shutdown", async () => {
    log("session_shutdown");
    broadcast({ dir: "out", type: "event", event: { type: "session_shutdown" } });
    setBridgeStatus(undefined);
    for (const client of clients) {
      try { client.destroy(); } catch { /* ignore */ }
    }
    clients.clear();
    try {
      server.close();
    } catch {
      // ignore
    }
  });

  log("hooks registered");
}
