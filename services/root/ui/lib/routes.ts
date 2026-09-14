/**
 * The app has ONE page — the Root channel — and OVERLAYS, addressed by
 * query params so any view is a link:
 *
 * ```
 * /                          the Root channel (the Head's session)
 * /?agent=Engineer:root::e-4f2a    … a teammate's session, read-only
 * /?workspace=pr-1521              … a workspace's terminal
 * /?call=c-x9                      … a call's live thread
 * /?channel=engineering            … which channel is open
 * /?task=t-4f2a                    … a task thread (right panel)
 * ```
 *
 * `?task=` COMPOSES with the center view (a Slack thread panel, not a
 * modal): it rides beside the open channel.
 */

export type Overlay =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workspace"; readonly name: string }
  | { readonly kind: "call"; readonly id: string };

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

export const overlayPath = (overlay: Overlay | undefined): string =>
  overlay === undefined
    ? "/"
    : overlay.kind === "agent"
      ? `/?agent=${encodeURIComponent(overlay.id)}`
      : overlay.kind === "workspace"
        ? `/?workspace=${encodeURIComponent(overlay.name)}`
        : `/?call=${encodeURIComponent(overlay.id)}`;

export const OVERLAY_EVENT = "root:overlay";

/** Navigate to an overlay (or none) — history-aware, app-internal. */
export const showOverlay = (overlay: Overlay | undefined): void => {
  window.history.pushState({}, "", overlayPath(overlay));
  window.dispatchEvent(new Event(OVERLAY_EVENT));
};

/* ── the task ledger: index view + thread panel ───────────────────── */

export const taskFromLocation = (): string | undefined =>
  new URLSearchParams(window.location.search).get("task") ?? undefined;

/** The current URL with ONLY the given params changed — the task
 *  panel and index compose with the open channel instead of
 *  replacing it. Every view is a path, so everything deep-links. */
export const patchedPath = (
  patch: Record<string, string | undefined>,
): string => {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  return search.length === 0 ? "/" : `/?${search}`;
};

const patchLocation = (patch: Record<string, string | undefined>): void => {
  window.history.pushState({}, "", patchedPath(patch));
  window.dispatchEvent(new Event(OVERLAY_EVENT));
};

/** A task thread's link target — for real <a href>s (cmd-click,
 *  copy-link) with an onClick that routes in-app. */
export const taskPath = (id: string): string => patchedPath({ task: id });

/** Open (or close) a task's thread panel beside the center view. */
export const showTask = (id: string | undefined): void =>
  patchLocation({ task: id });
