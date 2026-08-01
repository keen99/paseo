import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  PiBridgeAttachSession,
  bridgeSocketPathForSession,
  bridgeSocketExists,
  discoverLivePiBridges,
  type BridgeHello,
} from "./bridge-attach.js";

interface FakeBridge {
  path: string;
  server: Server;
  sockets: Set<Socket>;
  received: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
const removeSocket = async (path: string) => unlink(path).catch(() => undefined);

async function startFakeBridge(state: BridgeHello): Promise<FakeBridge> {
  if (!state.sessionId) throw new Error("fake bridge requires session id");
  const path = bridgeSocketPathForSession(state.sessionId);
  await removeSocket(path);
  const sockets = new Set<Socket>();
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify({ dir: "out", type: "hello", state })}\n`);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        if (message.type === "get_messages") {
          socket.write(`${JSON.stringify({ dir: "out", type: "messages", messages: [] })}\n`);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeSocket(path);
  };
  const bridge = { path, server, sockets, received, close };
  cleanups.push(close);
  return bridge;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => undefined);
});

describe("Pi session-addressed live bridge", () => {
  test("uses distinct paths for sessions in same cwd", () => {
    const first = bridgeSocketPathForSession("session-one");
    const second = bridgeSocketPathForSession("session-two");
    expect(first).not.toBe(second);
    expect(first).toBe("/tmp/paseo-pi-bridge-session-session-one.sock");
  });

  test("discovers and selects multiple live sessions in one cwd", async () => {
    const cwd = `/tmp/paseo-bridge-test-${randomUUID()}`;
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstFile = `${cwd}/first.jsonl`;
    const secondFile = `${cwd}/second.jsonl`;
    await startFakeBridge({
      sessionId: firstId,
      sessionFile: firstFile,
      sessionName: "first",
      cwd,
      isStreaming: false,
    });
    await startFakeBridge({
      sessionId: secondId,
      sessionFile: secondFile,
      sessionName: "second",
      cwd,
      isStreaming: true,
    });

    const all = await discoverLivePiBridges({ cwd });
    expect(all.map((bridge) => bridge.sessionId).sort()).toEqual([firstId, secondId].sort());
    expect(await discoverLivePiBridges({ cwd, expectedSessionFile: secondFile })).toMatchObject([
      { sessionId: secondId, sessionFile: secondFile, isStreaming: true },
    ]);
    await expect(bridgeSocketExists(cwd, { expectedSessionId: firstId })).resolves.toBe(true);
    await expect(bridgeSocketExists(cwd, { expectedSessionId: randomUUID() })).resolves.toBe(false);
  });

  test("attaches to exact session and relays frames and events", async () => {
    const cwd = `/tmp/paseo-bridge-test-${randomUUID()}`;
    const sessionId = randomUUID();
    const sessionFile = `${cwd}/session.jsonl`;
    const bridge = await startFakeBridge({
      sessionId,
      sessionFile,
      sessionName: "attached",
      cwd,
      isStreaming: false,
    });
    const attached = new PiBridgeAttachSession(bridge.path, {
      expectedSessionId: sessionId,
      expectedSessionFile: sessionFile,
    });
    cleanups.push(() => attached.close());

    await expect(attached.ready()).resolves.toMatchObject({ sessionId, sessionFile, cwd });
    const events: string[] = [];
    attached.onEvent((event) => events.push(event.type));
    await attached.prompt("hello");
    await attached.getMessages();
    for (const socket of bridge.sockets) {
      socket.write(
        `${JSON.stringify({ dir: "out", type: "event", event: { type: "command_output", data: { text: "usage" } } })}\n`,
      );
    }
    await waitFor(() => events.includes("command_output"));
    expect(bridge.received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "prompt", message: "hello" }),
        expect.objectContaining({ type: "get_messages" }),
      ]),
    );
  });

  test("reconnects to same session socket", async () => {
    const cwd = `/tmp/paseo-bridge-test-${randomUUID()}`;
    const sessionId = randomUUID();
    const sessionFile = `${cwd}/session.jsonl`;
    const state: BridgeHello = {
      sessionId,
      sessionFile,
      sessionName: "reconnect",
      cwd,
      isStreaming: false,
    };
    const first = await startFakeBridge(state);
    const attached = new PiBridgeAttachSession(first.path, {
      expectedSessionId: sessionId,
      expectedSessionFile: sessionFile,
    });
    cleanups.push(() => attached.close());
    await attached.ready();
    const events: string[] = [];
    attached.onEvent((event) => events.push(event.type));
    await first.close();
    await waitFor(() => events.includes("live_disconnected"));
    const second = await startFakeBridge(state);
    await waitFor(() => events.includes("live_connected"));
    expect(second.sockets.size).toBeGreaterThan(0);
  });
});
