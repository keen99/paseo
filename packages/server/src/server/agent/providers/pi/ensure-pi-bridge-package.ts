import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

/**
 * Resolve the bundled pi-paseo-bridge package directory.
 *
 * Layout differs between dev (source tree) and packaged (dist) builds:
 * - Dev:   <repo>/packages/server/src/server/agent/providers/pi/pi-paseo-bridge
 * - Dist:  <repo>/packages/server/dist/server/server/agent/providers/pi/pi-paseo-bridge
 *
 * Detection mirrors resolveBundledWebUiDistDir: inspect moduleDir basename
 * chain to pick the right layout.
 */
export function resolveBundledPiBridgeDir(
  moduleUrl: string | URL = import.meta.url,
): string | null {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));

  // Dev (ts-source / tsx): moduleDir = .../src/server/agent/providers/pi.
  // Prefer source so /reload picks up edits without rebuild.
  if (moduleDir.includes(path.join("packages", "server", "src"))) {
    const candidate = path.join(moduleDir, "pi-paseo-bridge");
    if (existsSync(candidate)) return candidate;
  }

  // Dist: moduleDir = .../dist/server/server/agent/providers/pi.
  // Fallback for packaged builds.
  const candidate = path.join(moduleDir, "pi-paseo-bridge");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve ~/.pi/agent directory. Returns null if pi does not appear installed
 * (no settings.json and no directory).
 */
function resolvePiAgentDir(): string | null {
  const piAgentDir = path.join(os.homedir(), ".pi", "agent");
  if (!existsSync(piAgentDir)) return null;
  return piAgentDir;
}

interface PiSettings {
  packages?: string[];
  disabledpackages?: string[];
  [key: string]: unknown;
}

function readPiSettings(settingsPath: string): PiSettings | null {
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as PiSettings;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!Array.isArray(parsed.packages)) parsed.packages = [];
    if (!Array.isArray(parsed.disabledpackages)) parsed.disabledpackages = [];
    return parsed;
  } catch {
    return null;
  }
}

const PASEO_BRIDGE_PACKAGE_KEY = "paseo-pi-bridge";

/**
 * Ensure the pi-paseo-bridge package is registered in ~/.pi/agent/settings.json
 * so every pi launch (including the user's own CLI) loads the bridge extension.
 *
 * Idempotent: no-op if the package path is already present, or if pi is not
 * installed, or if the bridge package cannot be resolved.
 *
 * Also removes any stale entries pointing at the paseo repo under different
 * relative paths (keeps only the current resolved path).
 */
export async function ensurePiBridgePackageRegistered(
  logger: Logger,
  options: { moduleUrl?: string | URL } = {},
): Promise<void> {
  const bridgeDir = resolveBundledPiBridgeDir(options.moduleUrl);
  if (!bridgeDir) {
    logger.debug({ bridgeDir: null }, "pi_bridge.resolve_failed");
    return;
  }

  const piAgentDir = resolvePiAgentDir();
  if (!piAgentDir) {
    logger.debug({ piAgentDir: null }, "pi_bridge.pi_not_installed");
    return;
  }

  const settingsPath = path.join(piAgentDir, "settings.json");
  const settings = readPiSettings(settingsPath);
  if (!settings) {
    logger.debug({ settingsPath }, "pi_bridge.settings_unreadable");
    return;
  }

  // Idempotent: already registered with the resolved path.
  const existing = settings.packages ?? [];
  const isRegistered = existing.some(
    (entry) => normalizePackagePath(entry) === normalizePackagePath(bridgeDir),
  );
  if (isRegistered) {
    logger.debug({ bridgeDir }, "pi_bridge.already_registered");
    return;
  }

  // Filter out stale paseo-bridge entries (old paths) before adding the current one.
  const cleaned = existing.filter((entry) => !isStalePaseoBridgeEntry(entry, bridgeDir));
  cleaned.push(bridgeDir);
  settings.packages = cleaned;

  try {
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    logger.info(
      { bridgeDir, settingsPath, removed: existing.length - cleaned.length + 1 },
      "pi_bridge.registered",
    );
  } catch (error) {
    logger.warn({ err: error, settingsPath }, "pi_bridge.write_failed");
  }
}

function normalizePackagePath(entry: string): string {
  // Expand ~ and resolve to absolute for comparison.
  if (entry.startsWith("~/")) {
    return path.resolve(os.homedir(), entry.slice(2));
  }
  if (entry === "~") {
    return os.homedir();
  }
  return path.resolve(entry);
}

/**
 * Detect entries that look like a stale paseo-bridge package path: mentions
 * "pi-paseo-bridge" or "paseo-bridge" but does not equal the current resolved dir.
 */
function isStalePaseoBridgeEntry(entry: string, currentBridgeDir: string): boolean {
  if (normalizePackagePath(entry) === normalizePackagePath(currentBridgeDir)) return false;
  const lower = entry.toLowerCase();
  return lower.includes("pi-paseo-bridge") || lower.includes("paseo-bridge");
}

export { PASEO_BRIDGE_PACKAGE_KEY };
