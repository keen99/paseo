# Unified Pi Session Discovery — Design

Status: draft. Prototype branch `pi-live-share`.

## Problem

Paseo session management today assumes the user already knows what it does.
Two separate flows exist: "recent sessions" (paseo-owned agents, spawn-based)
and "import session" (copy a pi jsonl into paseo ownership). Live CLI sessions
are invisible unless explicitly attached.

Goal: a ChatGPT-style list of pi sessions where the user can open, read,
connect live, launch headless, or fork — without knowing which "mode" they're
in. Discovery is the source of truth; ownership is an overlay.

## Session model

Two independent axes. Do not conflate.

### Identity (stable)
- pi session id (uuid) + cwd
- exists whether or not paseo touched it
- source of truth = pi's own session dir (`~/.pi/agent/sessions/`)

### State (computed per view, cheap)
- `live` — bridge socket alive now (`/tmp/paseo-pi-bridge-session-<id>.sock` answers JSON hello)
- `dormant` — no bridge socket. may still be headed in a shell without the extension loaded; we treat that as dormant and surface a notice.

No "headed-without-bridge" concept. No bridge = dormant. If the user expects
live but sees dormant, surface an info-level inline notice (not a warning):
"No live head found. Open read-only, or launch headless?"

### State detection scope
- live probe runs **only while a thread is in active view** (open tab visible).
- background tabs / closed threads pause probing. cheap.
- rescan triggers: interval (default 60s, configurable), manual refresh button,
  window/tab focus regained.

### Metadata overlay (sparse, optional)
Default: nothing. Paseo writes metadata only when the user acts.
Optional fields:
- `displayName` — rename
- `pinned` — sticky to top
- `folder` / `groupId` — ui grouping
- `forkedFrom` — pi session id this was forked from
- `forkedAt` — timestamp

**Location:** per-session, next to the pi jsonl, not a central blob. Match the
pattern of pi's own per-session sidecar metadata. Rationale: session wipe
removes metadata; no orphaned central entries; cheap per-session read.

Path candidate: `<pi-session-dir>/<session-id>.paseo-meta.json`

Paseo never deletes or rewrites the pi jsonl itself. Metadata is additive.

## List source

- scan `~/.pi/agent/sessions/` (nested by cwd slug) on interval + manual refresh
- overlay paseo metadata sidecars (sparse)
- passthrough pi's own session metadata (title etc) for display when no rename
- cwd grouping (matching `--resume` menu behavior)
- sort: recent mtime desc by default. pinned override to top. folders/groups
  filter ui-side. user sort options later.
- search/filter later.

### Config
- `scanEnabled` (bool, default false) — auto-scan + populate list
- `scanIntervalMs` (default 60000)
- off by default = user opt-in. your personal preference = on.

## On open session (context-aware)

The same list entry opens differently based on state:

- `live` → join (attach to bridge). both windows work in parallel.
- `dormant` → open read-only history review. no spawn. no side effects.

Explicit actions always available on any session:
- **Open headless** — spawn `pi --resume <id>` headless + attach. explicit user
  action, not auto fallback. breaks "never spawn" rule only via explicit intent.
- **Fork** — copy jsonl → new pi session in same cwd + same pi session dir
  structure. create metadata sidecar `forkedFrom=<id>`, `forkedAt=<ts>`.
  forked session = new pi session id; may itself go live later if resumed.

### Fork details
- write new jsonl into pi's session dir (same cwd slug, new id + timestamp).
  pi needs to find it via `--resume`, so it must live where pi scans.
- create paseo metadata sidecar marking origin.
- ui badge/icon for forks (branch glyph).
- forked session still subject to live detection like any other.

## Unified list vs current UI

Current app has:
- "recent sessions" (paseo agents)
- "add project" flow (spawn fresh)

Proposal: the unified scan **becomes** the recent list. No separate "paseo-owned
vs discovered" distinction in the ui. A session is a session.

"Add project" stays for the case: spawn a brand-new headless agent with no
prior session. separate entry point.

## Phase order

1. flip `PI_LIVE_UI` flag back on. rebuild live-share ui gating.
2. session scanner: scan pi sessions dir, overlay metadata sidecars. backend
   endpoint to list discovered sessions (with live state hint, computed lazily).
3. unified list ui: replace recent-sessions with scan results. per-active-tab
   live probe.
4. open context actions: review (read-only), join live, open headless, fork.
5. metadata store: rename, pin, folder (minimal set first).
6. scan config toggle + interval.

## Open questions / risks

- **pi `--resume` discovery scope**: does pi scan arbitrary paths or only its
  own session dir? must write forks into pi's dir regardless. confirm.
- **scan perf**: 100s of sessions = trivial (stat only). cache mtime tree,
  diff on rescan if needed. defer until measured.
- **fork create id**: how to mint a valid pi session id + timestamp-prefixed
  filename that pi will accept on `--resume`. check pi session file naming.
- **read-only review**: render pi jsonl history without spawning. reuse
  existing history-mapper. confirm it works headless (no provider needed).
- **metadata path collision**: pi may later add its own sidecar format.
  `.paseo-meta.json` suffix avoids collision; revisit if pi adopts one.
