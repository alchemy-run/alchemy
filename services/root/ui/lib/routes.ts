/**
 * RESOURCEFUL urls — places are PATHS (the twitter-permalink move),
 * transient chrome is query:
 *
 * ```
 * /                     the default feed (#root)
 * /c/engineering        a channel
 * /t/t-mu1l0zyu-5m9a    a task thread — standalone: a task BELONGS to
 *                       no channel; it is REFERENCED from places (a
 *                       post's pill, the rail, later a quote-post)
 * ?agent=…  ?workspace=…  ?call=…
 *                       overlays, riding on ANY path — a peek over
 *                       the current place, not a place of their own
 * ```
 */

export type Overlay =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workspace"; readonly name: string }
  | { readonly kind: "call"; readonly id: string };

/** One event for every in-app navigation — views re-read location. */
export const OVERLAY_EVENT = "root:overlay";

const navigate = (url: string): void => {
  window.history.pushState({}, "", url);
  window.dispatchEvent(new Event(OVERLAY_EVENT));
};

/* ── places (paths) ───────────────────────────────────────────────── */

const segments = (): ReadonlyArray<string> =>
  window.location.pathname.split("/").filter(Boolean);

export const channelPath = (name: string): string =>
  name === "root" ? "/" : `/c/${encodeURIComponent(name)}`;

/** The channel the path names — undefined off channel paths. */
export const channelFromLocation = (): string | undefined => {
  const parts = segments();
  if (parts.length === 0) return "root";
  return parts[0] === "c" && parts[1] !== undefined
    ? decodeURIComponent(parts[1])
    : undefined;
};

export const taskPath = (id: string): string => `/t/${encodeURIComponent(id)}`;

export const taskFromLocation = (): string | undefined => {
  const parts = segments();
  return parts[0] === "t" && parts[1] !== undefined
    ? decodeURIComponent(parts[1])
    : undefined;
};

export const showChannel = (name: string): void => navigate(channelPath(name));

/** Focus a task's thread — its own place, wherever it was referenced
 *  from. */
export const showTask = (id: string): void => navigate(taskPath(id));

/* ── overlays (query over the current path) ───────────────────────── */

export const overlayFromLocation = (): Overlay | undefined => {
  const params = new URLSearchParams(window.location.search);
  const agent = params.get("agent");
  if (agent !== null) return { kind: "agent", id: agent };
  const workspace = params.get("workspace");
  if (workspace !== null) return { kind: "workspace", name: workspace };
  const call = params.get("call");
  if (call !== null) return { kind: "call", id: call };
  return undefined;
};

/** The overlay's url ON the current path — closing one returns to the
 *  place it covered. */
export const overlayPath = (overlay: Overlay | undefined): string => {
  const base = window.location.pathname;
  return overlay === undefined
    ? base
    : overlay.kind === "agent"
      ? `${base}?agent=${encodeURIComponent(overlay.id)}`
      : overlay.kind === "workspace"
        ? `${base}?workspace=${encodeURIComponent(overlay.name)}`
        : `${base}?call=${encodeURIComponent(overlay.id)}`;
};

/** Navigate to an overlay (or none) — history-aware, app-internal. */
export const showOverlay = (overlay: Overlay | undefined): void =>
  navigate(overlayPath(overlay));

/** Pre-path urls (`/?channel=…`, `/?task=…`) translate ONCE at boot —
 *  old links keep resolving; overlay params survive untouched. */
export const normalizeLegacyLocation = (): void => {
  const params = new URLSearchParams(window.location.search);
  const task = params.get("task");
  const channel = params.get("channel");
  if (task === null && channel === null) return;
  window.history.replaceState(
    {},
    "",
    task !== null ? taskPath(task) : channelPath(channel!),
  );
};
