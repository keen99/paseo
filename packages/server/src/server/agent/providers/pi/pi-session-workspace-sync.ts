import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { listDiscoveredPiSessions } from "./session-discovery.js";

/**
 * Pi session → workspace sync.
 *
 * When piSessionDiscovery.scanEnabled is on, every pi session's cwd becomes a
 * paseo project + directory workspace so the sidebar (and every client,
 * including unmodified mobile) shows them.
 *
 * Synced records are tagged with projectKey `__pi_session_scan__` so the
 * reconciler only manages its own records; user-added workspaces are untouched.
 */

export const PI_SESSION_SCAN_PROJECT_KEY = "__pi_session_scan__";
export const PI_SESSION_SCAN_SOURCE = "pi_session_scan";

export interface PiSessionWorkspaceSyncDeps {
  workspaceRegistry: {
    list(): Promise<
      ReadonlyArray<
        Record<string, unknown> & { workspaceId: string; projectId: string; cwd: string }
      >
    >;
    upsert(record: Record<string, unknown>, context?: unknown): Promise<void>;
  };
  projectRegistry: {
    list(): Promise<
      ReadonlyArray<
        Record<string, unknown> & { projectId: string; rootPath: string; archivedAt: string | null }
      >
    >;
    upsert(record: Record<string, unknown>): Promise<void>;
  };
  logger?: Logger;
}

/**
 * Run one sync pass. Idempotent. Returns counts for logging.
 */
export async function syncPiSessionWorkspaces(
  deps: PiSessionWorkspaceSyncDeps,
): Promise<{ scanned: number; cwds: number; upserted: number }> {
  const log = deps.logger;
  const sessions = await listDiscoveredPiSessions({ limit: 200 });
  log?.debug({ count: sessions.length }, "pi_session_sync.scanned");

  // Unique cwds with session count + last activity.
  const byCwd = new Map<string, { cwd: string; lastActivityAt: Date }>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const existing = byCwd.get(s.cwd);
    if (!existing || s.lastActivityAt > existing.lastActivityAt) {
      byCwd.set(s.cwd, { cwd: s.cwd, lastActivityAt: s.lastActivityAt });
    }
  }

  // Existing synced projects keyed by rootPath.
  const projects = await deps.projectRegistry.list();
  const syncedProjectsByPath = new Map<string, { projectId: string }>();
  for (const p of projects) {
    if (p.archivedAt) continue;
    if ((p as { projectKey?: string | null }).projectKey !== PI_SESSION_SCAN_PROJECT_KEY) continue;
    syncedProjectsByPath.set(p.rootPath, { projectId: p.projectId });
  }

  // Existing synced workspaces keyed by cwd.
  const workspaces = await deps.workspaceRegistry.list();
  const syncedWorkspacesByCwd = new Map<string, { workspaceId: string }>();
  for (const w of workspaces) {
    if ((w as { projectKey?: string | null }).projectKey !== PI_SESSION_SCAN_PROJECT_KEY) continue;
    syncedWorkspacesByCwd.set(w.cwd, { workspaceId: w.workspaceId });
  }

  const now = new Date().toISOString();
  let upserted = 0;

  for (const [, { cwd }] of byCwd) {
    // Project
    let projectId = syncedProjectsByPath.get(cwd)?.projectId;
    if (!projectId) {
      projectId = `piscan_${randomUUID()}`;
      await deps.projectRegistry.upsert({
        projectId,
        rootPath: cwd,
        projectKey: PI_SESSION_SCAN_PROJECT_KEY,
        displayName: deriveProjectName(cwd),
        kind: "directory",
        gitRemoteUrl: null,
        customName: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      upserted += 1;
    }

    // Workspace
    const existingWs = syncedWorkspacesByCwd.get(cwd);
    const workspaceId = existingWs?.workspaceId ?? `piscanws_${randomUUID()}`;
    await deps.workspaceRegistry.upsert({
      workspaceId,
      projectId,
      cwd,
      kind: "directory",
      displayName: deriveWorkspaceName(cwd),
      title: null,
      branch: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      projectKey: PI_SESSION_SCAN_PROJECT_KEY,
    });
    upserted += 1;
  }

  log?.info({ scanned: sessions.length, cwds: byCwd.size, upserted }, "pi_session_sync.complete");
  return { scanned: sessions.length, cwds: byCwd.size, upserted };
}

function deriveProjectName(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

function deriveWorkspaceName(cwd: string): string {
  return deriveProjectName(cwd);
}
