#!/usr/bin/env node
/**
 * Unified dev runner: starts paseo server + app in foreground.
 * Prefixed color logs. Ctrl+C kills both cleanly.
 *
 * Usage:
 *   node scripts/dev.mjs            # default ports 6768 + 8081
 *   PORT=8082 node scripts/dev.mjs  # custom app port
 *
 * Env:
 *   SERVER_PORT (default 6768)  - daemon listen port
 *   APP_PORT    (default 8081)  - metro/expo port
 *   SKIP_BUILD  (default 0)     - set 1 to skip dev server deps rebuild
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER_PORT = process.env.SERVER_PORT ?? "6768";
const APP_PORT = process.env.APP_PORT ?? process.env.PORT ?? "8081";
const SKIP_BUILD = process.env.SKIP_BUILD === "1";

const LOG_DIR = join(ROOT, ".dev", "logs");
mkdirSync(LOG_DIR, { recursive: true });

const COLORS = {
  server: "\x1b[36m", // cyan
  app: "\x1b[35m",    // magenta
  sys: "\x1b[33m",    // yellow
  reset: "\x1b[0m",
};

const procs = [];
let shuttingDown = false;

function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function line(tag, msg) {
  const c = COLORS[tag] ?? COLORS.sys;
  for (const l of String(msg).split("\n")) {
    process.stdout.write(`${c}[${ts()} ${tag.padEnd(6)}]${COLORS.reset} ${l}\n`);
  }
}

function tee(tag) {
  const file = join(LOG_DIR, `${tag}.log`);
  const stream = createWriteStream(file, { flags: "w" });
  return (data) => {
    const text = data.toString();
    stream.write(text);
    line(tag, text.replace(/\n$/, ""));
  };
}

function spawnProc(name, cmd, args, env) {
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push({ name, p });
  p.stdout.on("data", tee(name));
  p.stderr.on("data", tee(name));
  p.on("exit", (code, signal) => {
    line("sys", `${name} exited (code=${code} signal=${signal})`);
    if (!shuttingDown) shutdown(code === 0 ? 0 : 1);
  });
  return p;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  line("sys", "shutting down (sending SIGTERM to children)...");
  for (const { name, p } of procs) {
    if (!p.killed) {
      try { p.kill("SIGTERM"); } catch {}
    }
  }
  // force kill after 3s
  setTimeout(() => {
    for (const { name, p } of procs) {
      if (!p.killed) {
        line("sys", `${name} did not exit, SIGKILL`);
        try { p.kill("SIGKILL"); } catch {}
      }
    }
    process.exit(code);
  }, 3000).unref();
}

process.on("SIGINT", () => { line("sys", "^C"); shutdown(130); });
process.on("SIGTERM", () => shutdown(143));

line("sys", `paseo dev — server :${SERVER_PORT}  app :${APP_PORT}`);
line("sys", `logs → ${LOG_DIR}{server,app}.log`);
line("sys", `cwd  ${ROOT}`);

// server env mirrors scripts/dev-daemon.sh + dev-home.sh defaults
const serverEnv = {
  PASEO_LISTEN: `127.0.0.1:${SERVER_PORT}`,
  ...(SKIP_BUILD ? { PASEO_SKIP_DEV_SERVER_BUILD: "1" } : {}),
};

// clear stale metro/expo cache so HMR picks up source changes
const cacheDirs = [
  join(ROOT, "packages/app/.expo/web"),
  join(ROOT, "packages/app/node_modules/.cache/metro"),
];
for (const dir of cacheDirs) {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      line("sys", `cleared cache: ${dir}`);
    }
  } catch (e) {
    line("sys", `cache clear failed (${dir}): ${e?.message ?? e}`);
  }
}

spawnProc("server", "npm", ["run", "dev:server"], serverEnv);

// slight delay so server binds before app tries to connect
setTimeout(() => {
  spawnProc("app", "npm", ["run", "dev:app"], {
    PASEO_LISTEN: `127.0.0.1:${SERVER_PORT}`,
    EXPO_PORT: APP_PORT,
    BROWSER: "none",
  });
}, 2000);
