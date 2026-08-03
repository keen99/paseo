import { copyFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";

import type { ImportableProviderSession } from "../../agent-sdk-types.js";
import { discoverLivePiBridges } from "./bridge-attach.js";
import { listPiImportableSessions, readPiImportSessionConfig } from "./session-descriptor.js";

/**
 * Paseo metadata sidecar for a pi session.
 *
 * Sparse: only fields the user has explicitly set exist. Default session has
 * no sidecar file at all.
 *
 * Lives next to the pi jsonl so session wipe removes it. Suffix avoids
 * collision with any future pi-native sidecar format.
 */
export interface PiSessionPaseoMeta {
  /** User-set display name. Overrides pi's title in the UI when present. */
  displayName?: string;
  /** Sticky-to-top flag. */
  pinned?: boolean;
  /** Folder/group id for UI grouping. */
  folder?: string;
  /** Pi session id this session was forked from (if a fork). */
  forkedFrom?: string;
  /** When the fork was created. */
  forkedAt?: string;
}

/**
 * A discovered pi session with paseo overlay metadata attached.
 *
 * `sessionId` is parsed from the jsonl filename (uuid portion).
 * `isLive` is computed lazily via bridge probe (caller-scope).
 */
export interface DiscoveredPiSession extends ImportableProviderSession {
  /** Pi session id (uuid). */
  sessionId: string;
  /** Absolute path to the pi jsonl. */
  sessionFile: string;
  /** Paseo overlay metadata (empty object if no sidecar). */
  meta: PiSessionPaseoMeta;
  /** Live head detected (bridge socket alive). Caller probes on demand. */
  isLive: boolean;
}

const META_SUFFIX = ".paseo-meta.json";

/**
 * Scan pi sessions dir, parse descriptors, attach sessionId + metadata overlay.
 *
 * Does NOT probe live state. Caller does that per-active-thread via
 * `probeLiveState()`. Keeps scan cheap (no socket I/O per session).
 *
 * @param options.cwd optional cwd filter
 * @param options.limit max results (default 50)
 * @param options.logger
 */
export async function listDiscoveredPiSessions(
  options: {
    cwd?: string;
    limit?: number;
    logger?: Logger;
  } = {},
): Promise<DiscoveredPiSession[]> {
  const limit = options.limit ?? 50;
  const imported = await listPiImportableSessions({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    limit,
  });

  const sessions = await Promise.all(imported.map((entry) => augmentWithPaseoData(entry)));

  return sessions;
}

/** Augment an ImportableProviderSession with sessionId, metadata, live=false. */
async function augmentWithPaseoData(
  entry: ImportableProviderSession,
): Promise<DiscoveredPiSession> {
  const sessionId = parseSessionIdFromHandle(entry.providerHandleId);
  const sessionFile = entry.providerHandleId;
  const meta = await readPaseoMetaSidecar(sessionFile);
  return {
    ...entry,
    sessionId,
    sessionFile,
    meta,
    isLive: false,
  };
}

/**
 * Probe live state for a set of sessions. Returns the same array with `isLive`
 * updated. Intended for the active-view set only (bounded, not the whole list).
 *
 * Uses discoverLivePiBridges once (batched read of /tmp dir + per-socket hello),
 * then maps results by sessionId.
 */
export async function probeLiveState(
  sessions: DiscoveredPiSession[],
): Promise<DiscoveredPiSession[]> {
  if (sessions.length === 0) return sessions;
  const liveBridges = await discoverLivePiBridges();
  const liveSessionIds = new Set(liveBridges.map((b) => b.sessionId).filter(Boolean));
  return sessions.map((s) => ({ ...s, isLive: liveSessionIds.has(s.sessionId) }));
}

/** Parse the uuid session id from a pi jsonl filename. */
export function parseSessionIdFromHandle(filePath: string): string {
  const base = path.basename(filePath);
  // pattern: <timestamp>_<uuid>.jsonl
  const match = base.match(
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? base.replace(/\.jsonl$/, "");
}

/**
 * Read the paseo metadata sidecar for a pi session jsonl, if present.
 * Returns empty object if no sidecar exists or is unreadable.
 */
export async function readPaseoMetaSidecar(sessionFile: string): Promise<PiSessionPaseoMeta> {
  const sidecarPath = sessionFile.replace(/\.jsonl$/i, META_SUFFIX);
  try {
    const raw = await readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(raw) as PiSessionPaseoMeta;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export { readPiImportSessionConfig, META_SUFFIX };

/**
 * Merge sparse updates into the paseo-meta sidecar for a pi session.
 * null = clear field. undefined = leave unchanged.
 * Creates the sidecar if none exists.
 */
export async function updatePaseoMetaSidecar(
  sessionFile: string,
  patch: {
    displayName?: string | null;
    pinned?: boolean | null;
    folder?: string | null;
  },
): Promise<PiSessionPaseoMeta> {
  const sidecarPath = sessionFile.replace(/\.jsonl$/i, META_SUFFIX);
  const current = await readPaseoMetaSidecar(sessionFile);
  const merged: PiSessionPaseoMeta = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete (merged as Record<string, unknown>)[key];
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

/**
 * Fork a pi session: copy jsonl to new pi session file (new uuid), write
 * paseo-meta sidecar marking origin. Original untouched.
 *
 * Filename pattern: <timestamp>_<uuid>.jsonl, matching pi's own layout,
 * so `pi --resume` discovers the fork.
 */
export async function forkPiSession(sourceSessionFile: string): Promise<{
  sessionFile: string;
  sessionId: string;
}> {
  const dir = path.dirname(sourceSessionFile);
  const newId = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newFile = path.join(dir, `${stamp}_${newId}.jsonl`);
  await copyFile(sourceSessionFile, newFile);
  await updatePaseoMetaSidecar(newFile, {});
  // Overwrite sidecar with fork lineage.
  const sidecarPath = newFile.replace(/\.jsonl$/i, META_SUFFIX);
  await writeFile(
    sidecarPath,
    JSON.stringify(
      {
        forkedFrom: parseSessionIdFromHandle(sourceSessionFile),
        forkedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { sessionFile: newFile, sessionId: newId };
}
