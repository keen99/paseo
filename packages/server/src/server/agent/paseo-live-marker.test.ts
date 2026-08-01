import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearPaseoLiveMarker,
  paseoLiveMarkerPath,
  writePaseoLiveMarker,
} from "./paseo-live-marker.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-marker-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("paseo.live marker", () => {
  test("path is sibling of native handle", () => {
    expect(paseoLiveMarkerPath("/srv/sess.jsonl")).toBe("/srv/sess.jsonl.paseo.live");
    expect(paseoLiveMarkerPath(undefined)).toBeNull();
  });

  test("write creates marker file", async () => {
    const handle = join(dir, "session.jsonl");
    await writePaseoLiveMarker(handle);
    const markerStat = await stat(paseoLiveMarkerPath(handle)!);
    expect(markerStat.isFile()).toBe(true);
  });

  test("write is idempotent across dirs", async () => {
    const handle = join(dir, "nested", "deep", "session.jsonl");
    await writePaseoLiveMarker(handle);
    await writePaseoLiveMarker(handle);
    await expect(stat(paseoLiveMarkerPath(handle)!)).resolves.toBeDefined();
  });

  test("clear removes marker", async () => {
    const handle = join(dir, "session.jsonl");
    await writePaseoLiveMarker(handle);
    const marker = paseoLiveMarkerPath(handle)!;
    await clearPaseoLiveMarker(handle);
    await clearPaseoLiveMarker(handle); // no throw on absent
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("no-op without native handle", async () => {
    await expect(writePaseoLiveMarker(undefined)).resolves.toBeUndefined();
    await expect(clearPaseoLiveMarker(undefined)).resolves.toBeUndefined();
  });
});
