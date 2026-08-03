/**
 * Pi live-share UI feature flag.
 *
 * When true: composer gate, live health badge, diagnostics, home reorder,
 * import-session live probe, bridge state tracking all active.
 *
 * When false: main UI behavior. Composer always enabled. Send always.
 * Backend drives delivery decisions reactively. Unmodified-app equivalent.
 *
 * Toggle for testing main-UI flow without reverting code.
 */
export const PI_LIVE_UI = true;
