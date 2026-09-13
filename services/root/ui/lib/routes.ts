/**
 * The app has ONE page — the Root channel — and OVERLAYS, addressed by
 * query params so any view is a link:
 *
 * ```
 * /                          the Root channel (the Head's session)
 * /?agent=Engineer:root::e-4f2a    … a teammate's session, read-only
 * /?workspace=pr-1521              … a workspace's terminal
 * /?call=c-x9                      … a call's live thread
 * /?triage                         … the inbound valve (held events)
 * ```
 */

export type Overlay =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workspace"; readonly name: string }
  | { readonly kind: "call"; readonly id: string }
  | { readonly kind: "triage" };

export const overlayFromLocation = (): Overlay | undefined => {
  const params = new URLSearchParams(window.location.search);
  const agent = params.get("agent");
  if (agent !== null) return { kind: "agent", id: agent };
  const workspace = params.get("workspace");
  if (workspace !== null) return { kind: "workspace", name: workspace };
  const call = params.get("call");
  if (call !== null) return { kind: "call", id: call };
  if (params.has("triage")) return { kind: "triage" };
  return undefined;
};

export const overlayPath = (overlay: Overlay | undefined): string =>
  overlay === undefined
    ? "/"
    : overlay.kind === "agent"
      ? `/?agent=${encodeURIComponent(overlay.id)}`
      : overlay.kind === "workspace"
        ? `/?workspace=${encodeURIComponent(overlay.name)}`
        : overlay.kind === "call"
          ? `/?call=${encodeURIComponent(overlay.id)}`
          : "/?triage";

export const OVERLAY_EVENT = "root:overlay";

/** Navigate to an overlay (or none) — history-aware, app-internal. */
export const showOverlay = (overlay: Overlay | undefined): void => {
  window.history.pushState({}, "", overlayPath(overlay));
  window.dispatchEvent(new Event(OVERLAY_EVENT));
};
