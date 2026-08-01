/**
 * Pi live-attach client. Connects to bridge extension unix socket.
 * Implements PiRuntimeSession over bridge JSONL protocol.
 *
 * See pi-paseo-bridge/extension.mjs for protocol.
 */
import { connect, type Socket } from "node:net";
import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "./rpc-types.js";

export interface BridgeHello {
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  cwd: string;
  isStreaming: boolean;
}

const CONNECT_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 750;
const HEARTBEAT_STALE_MS = 7_000;
const BRIDGE_SOCKET_DIR = "/tmp";
const BRIDGE_SOCKET_PREFIX = "paseo-pi-bridge-session-";
const BRIDGE_SOCKET_SUFFIX = ".sock";

export interface DiscoveredPiBridge extends BridgeHello {
  socketPath: string;
}

/** Build session-addressed bridge path. Mirrors pi-paseo-bridge socketPathForSession. */
export function bridgeSocketPathForSession(sessionId: string): string {
  const slug = String(sessionId)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-96);
  if (!slug) {
    throw new Error("Pi bridge requires a session id");
  }
  return `${BRIDGE_SOCKET_DIR}/${BRIDGE_SOCKET_PREFIX}${slug}${BRIDGE_SOCKET_SUFFIX}`;
}

function matchesSessionFile(actual: string | null, expected: string | undefined): boolean {
  return (
    expected === undefined || (actual !== null && resolvePath(actual) === resolvePath(expected))
  );
}

function bridgeMatches(
  bridge: BridgeHello,
  expected: { cwd?: string; expectedSessionFile?: string; expectedSessionId?: string },
): boolean {
  return (
    (expected.cwd === undefined || resolvePath(bridge.cwd) === resolvePath(expected.cwd)) &&
    matchesSessionFile(bridge.sessionFile, expected.expectedSessionFile) &&
    (expected.expectedSessionId === undefined || bridge.sessionId === expected.expectedSessionId)
  );
}

async function probeBridgeSocket(socketPath: string): Promise<DiscoveredPiBridge | null> {
  return await new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: DiscoveredPiBridge | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guard makes finish idempotent.
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        if (message.dir !== "out" || message.type !== "hello") {
          finish(null);
          return;
        }
        const state = (message.state ?? {}) as Partial<BridgeHello>;
        if (!state.sessionId || !state.sessionFile || !state.cwd) {
          finish(null);
          return;
        }
        finish({
          socketPath,
          sessionFile: state.sessionFile,
          sessionId: state.sessionId,
          sessionName: state.sessionName ?? null,
          cwd: state.cwd,
          isStreaming: state.isStreaming ?? false,
        });
      } catch {
        finish(null);
      }
    });
    socket.once("error", () => finish(null));
  });
}

/** Discover every live Pi bridge, optionally narrowed to exact session identity. */
export async function discoverLivePiBridges(
  expected: { cwd?: string; expectedSessionFile?: string; expectedSessionId?: string } = {},
): Promise<DiscoveredPiBridge[]> {
  let names: string[];
  try {
    names = await readdir(BRIDGE_SOCKET_DIR);
  } catch {
    return [];
  }
  const paths = names
    .filter((name) => name.startsWith(BRIDGE_SOCKET_PREFIX) && name.endsWith(BRIDGE_SOCKET_SUFFIX))
    .map((name) => `${BRIDGE_SOCKET_DIR}/${name}`);
  const bridges = await Promise.all(paths.map(probeBridgeSocket));
  return bridges.filter(
    (bridge): bridge is DiscoveredPiBridge => bridge !== null && bridgeMatches(bridge, expected),
  );
}

/** Probe whether an exact live bridge exists. Cwd-only queries mean any live session in cwd. */
export async function bridgeSocketExists(
  cwd: string,
  expected: { expectedSessionFile?: string; expectedSessionId?: string } = {},
): Promise<boolean> {
  return (
    (
      await discoverLivePiBridges({
        cwd,
        expectedSessionFile: expected.expectedSessionFile,
        expectedSessionId: expected.expectedSessionId,
      })
    ).length > 0
  );
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Live-attach PiRuntimeSession. No spawn. Connects to a running pi process
 * that has the paseo bridge extension loaded.
 */
export class PiBridgeAttachSession {
  readonly isLiveBridge = true;
  private readonly socketPath: string;
  private sock: Socket | null = null;
  private buf = "";
  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private latestState: BridgeHello = {
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    cwd: "",
    isStreaming: false,
  };
  private helloReceived = false;
  private helloResolve: ((v: BridgeHello) => void) | null = null;
  private helloReject: ((e: Error) => void) | null = null;
  private readonly readyPromise: Promise<BridgeHello>;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionallyClosed = false;
  private connectedOnce = false;
  private lastHeartbeatAt = 0;
  private readonly watchdogTimer: NodeJS.Timeout;

  constructor(
    socketPath: string,
    private readonly expected: { expectedSessionFile?: string; expectedSessionId?: string } = {},
  ) {
    this.socketPath = socketPath;
    this.readyPromise = this.open();
    this.watchdogTimer = setInterval(() => {
      if (
        this.helloReceived &&
        this.lastHeartbeatAt > 0 &&
        Date.now() - this.lastHeartbeatAt > HEARTBEAT_STALE_MS
      ) {
        this.sock?.destroy(new Error("bridge heartbeat stale"));
      }
    }, 2_000);
    this.watchdogTimer.unref?.();
  }

  private open(): Promise<BridgeHello> {
    return new Promise<BridgeHello>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
      this.connectSocket();
    });
  }

  private connectSocket(): void {
    if (this.intentionallyClosed) return;
    this.buf = "";
    this.helloReceived = false;
    const sock = connect(this.socketPath);
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.setTimeout(CONNECT_TIMEOUT_MS);
    sock.on("connect", () => sock.setTimeout(0));
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.handleOutbound(msg);
      }
    });
    sock.on("timeout", () => {
      if (!this.helloReceived && this.helloReject) {
        this.helloReject(new Error(`bridge connect timeout: ${this.socketPath}`));
        this.helloResolve = null;
        this.helloReject = null;
      }
      sock.destroy();
    });
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
      this.latestState = { ...this.latestState, isStreaming: false };
      if (!this.intentionallyClosed) {
        for (const sub of this.subscribers) {
          sub({ type: "live_disconnected" } as PiRuntimeEvent);
        }
        this.scheduleReconnect();
      }
      this.failPending(new Error("bridge socket closed"));
    });
    sock.on("error", (err: Error) => {
      if (!this.connectedOnce && this.helloReject) {
        this.helloReject(err);
        this.helloResolve = null;
        this.helloReject = null;
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, 250);
  }

  private handleState(msg: Record<string, unknown>, isHello: boolean): void {
    const state = (msg.state ?? {}) as Partial<BridgeHello>;
    this.latestState = {
      sessionFile: state.sessionFile ?? null,
      sessionId: state.sessionId ?? null,
      sessionName: state.sessionName ?? null,
      cwd: state.cwd ?? "",
      isStreaming: state.isStreaming ?? false,
    };
    if (!isHello) return;

    const sessionFileMatches =
      this.expected.expectedSessionFile === undefined ||
      (this.latestState.sessionFile !== null &&
        resolvePath(this.latestState.sessionFile) ===
          resolvePath(this.expected.expectedSessionFile));
    const sessionIdMatches =
      this.expected.expectedSessionId === undefined ||
      this.latestState.sessionId === this.expected.expectedSessionId;
    if (!sessionFileMatches || !sessionIdMatches) {
      this.sock?.destroy(new Error("bridge session mismatch during reconnect"));
      return;
    }

    const reconnect = this.connectedOnce;
    this.helloReceived = true;
    this.lastHeartbeatAt = Date.now();
    this.connectedOnce = true;
    if (this.helloResolve) {
      this.helloResolve(this.latestState);
      this.helloResolve = null;
      this.helloReject = null;
    }
    if (reconnect) {
      for (const sub of this.subscribers) {
        sub({ type: "live_connected" } as PiRuntimeEvent);
      }
    }
  }

  private handleOutbound(msg: Record<string, unknown>): void {
    if (msg.dir !== "out") return;
    const type = msg.type as string;
    if (type === "hello" || type === "state") {
      this.handleState(msg, type === "hello");
      return;
    }
    if (type === "event") {
      const raw = msg.event as { type?: string; data?: object } | undefined;
      if (raw && typeof raw.type === "string") {
        if (raw.type === "live_heartbeat") this.lastHeartbeatAt = Date.now();
        const event = { type: raw.type, ...raw.data } as PiRuntimeEvent;
        for (const sub of this.subscribers) sub(event);
      }
      return;
    }
    if (type === "messages") {
      const req = this.pending.get("get_messages");
      if (req) {
        this.clearPending("get_messages");
        req.resolve((msg.messages as PiAgentMessage[]) ?? []);
      }
      return;
    }
    if (type === "error") {
      this.failPending(new Error(String(msg.error ?? "bridge error")));
    }
  }

  private failPending(err: Error): void {
    for (const [id, req] of this.pending) {
      this.clearPending(id);
      req.reject(err);
    }
  }

  private clearPending(id: string): void {
    const req = this.pending.get(id);
    if (req) {
      clearTimeout(req.timer);
      this.pending.delete(id);
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.sock || this.sock.destroyed) {
      throw new Error("bridge socket not open");
    }
    this.sock.write(JSON.stringify(msg) + "\n");
  }

  async ready(): Promise<BridgeHello> {
    return this.readyPromise;
  }

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck> {
    this.send({ dir: "in", type: "prompt", message, ...(images ? { images } : {}) });
    return { agentInvoked: true };
  }

  async compact(_customInstructions?: string): Promise<void> {
    // bridge doesn't expose compact yet
  }

  async setAutoCompaction(_enabled: boolean): Promise<void> {
    // not exposed via bridge
  }

  async abort(): Promise<void> {
    this.send({ dir: "in", type: "abort" });
  }

  async getState(): Promise<PiSessionState> {
    this.send({ dir: "in", type: "get_state" });
    const s = this.latestState;
    return {
      sessionId: s.sessionId ?? "",
      sessionFile: s.sessionFile ?? "",
      sessionName: s.sessionName ?? "",
      model: null,
      isStreaming: s.isStreaming,
      isCompacting: false,
      thinkingLevel: "medium",
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }

  async getMessages(): Promise<PiAgentMessage[]> {
    return new Promise<PiAgentMessage[]>((resolve, reject) => {
      const id = "get_messages";
      const timer = setTimeout(() => {
        this.clearPending(id);
        reject(new Error("bridge get_messages timeout"));
      }, 5_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ dir: "in", type: "get_messages" });
    });
  }

  async getAvailableModels(_timeoutMs?: number | null): Promise<PiModel[]> {
    return [];
  }

  async setModel(_provider: string, _modelId: string): Promise<PiModel> {
    throw new Error("bridge attach does not support setModel");
  }

  async setThinkingLevel(_level: string): Promise<void> {
    // not exposed
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return { tokens: {}, cost: 0 };
  }

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    return [];
  }

  async request(
    _command: { type: string; [key: string]: unknown },
    _timeoutMs?: number | null,
  ): Promise<unknown> {
    throw new Error("bridge attach does not support raw request");
  }

  sendRawFrame(_frame: object & { type: string }): void {
    // no-op
  }

  respondToExtensionUiRequest(
    _id: string,
    _response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    // not wired through bridge yet
  }

  cancelExtensionUiRequest(_id: string): void {
    // no-op
  }

  async close(): Promise<void> {
    this.intentionallyClosed = true;
    clearInterval(this.watchdogTimer);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.sock?.destroy();
    } catch {
      // ignore
    }
    this.sock = null;
    this.subscribers.clear();
    this.failPending(new Error("bridge session closed"));
  }
}
