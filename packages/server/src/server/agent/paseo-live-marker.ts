import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";

/**
 * Marker file signaling Paseo tracks a provider native session.
 * Pi bridge extension reads this at session_start; absence = fully silent
 * (no socket, no footer status).
 *
 * Marker lives next to the native session file (e.g. the Pi JSONL), so the
 * Pi process can self-check from a path it already knows.
 */
export function paseoLiveMarkerPath(nativeHandle: string | undefined): string | null {
  if (!nativeHandle) return null;
  return `${nativeHandle}.paseo.live`;
}

/** Write the marker. Best-effort; missing dir or failure is non-fatal. */
export async function writePaseoLiveMarker(
  nativeHandle: string | undefined,
  logger?: Logger,
): Promise<void> {
  const path = paseoLiveMarkerPath(nativeHandle);
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${Date.now()}\n`, "utf8");
  } catch (error) {
    logger?.debug({ err: error, path }, "paseo.live marker write failed");
  }
}

/** Remove the marker. Best-effort; absence or failure is non-fatal. */
export async function clearPaseoLiveMarker(
  nativeHandle: string | undefined,
  logger?: Logger,
): Promise<void> {
  const path = paseoLiveMarkerPath(nativeHandle);
  if (!path) return;
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return;
    logger?.debug({ err: error, path }, "paseo.live marker clear failed");
  }
}
