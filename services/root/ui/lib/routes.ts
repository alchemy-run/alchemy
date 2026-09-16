/**
 * RESOURCEFUL urls — places are PATHS (the twitter-permalink move),
 * transient chrome is query:
 *
 * ```
 * /                     the default feed (#root)
 * /c/engineering        a channel
 * /p/p-x1  /c/engineering/p/p-x1
 *                       a THREAD — clicked into from the feed; the
 *                       composer there speaks INTO the thread
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

/** An agent's PROFILE — the mirror of its charter (`/a/Head`). */
export const agentPath = (name: string): string =>
  `/a/${encodeURIComponent(name)}`;

export const agentFromLocation = (): string | undefined => {
  const parts = segments();
  return parts[0] === "a" && parts[1] !== undefined
    ? decodeURIComponent(parts[1])
    : undefined;
};

export const showAgent = (name: string): void => navigate(agentPath(name));

export const showChannel = (name: string): void => navigate(channelPath(name));

/** A thread's place — the channel's path with the root post under
 *  `/p/`. */
export const threadPath = (channel: string, id: string): string =>
  channel === "root"
    ? `/p/${encodeURIComponent(id)}`
    : `/c/${encodeURIComponent(channel)}/p/${encodeURIComponent(id)}`;

/** The thread (root post id) the path names — undefined elsewhere. */
export const threadFromLocation = (): string | undefined => {
  const parts = segments();
  if (parts[0] === "p" && parts[1] !== undefined) {
    return decodeURIComponent(parts[1]);
  }
  if (parts[0] === "c" && parts[2] === "p" && parts[3] !== undefined) {
    return decodeURIComponent(parts[3]);
  }
  return undefined;
};

/** Click INTO a thread — the feed shows the card, this is the place. */
export const showThread = (channel: string, id: string): void =>
  navigate(threadPath(channel, id));

/** Focus a task's thread — its own place, wherever it was referenced
 *  from. */
export const showTask = (id: string): void => navigate(taskPath(id));

/* ── panes and overlays (query over the current path) ─────────────
 *
 * `?panes=` is the PANE STACK — the column right-adjacent to the
 * thread, tmux-shaped: miller columns model depth, and every pane
 * opened from the thread lands in this one column, VERTICALLY split
 * with its siblings. Any mix, any count: agent workings (`a:<id>`)
 * and workspace terminals (`w:<name>`), comma-separated in click
 * order, each closable on its own. `?call=` is the one remaining
 * MODAL. */

/** One pane of the stack. */
export type Pane =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workspace"; readonly name: string };

const paneToken = (pane: Pane): string =>
  pane.kind === "agent"
    ? `a:${encodeURIComponent(pane.id)}`
    : `w:${encodeURIComponent(pane.name)}`;

const paneOfToken = (token: string): Pane | undefined => {
  if (token.startsWith("a:")) {
    return { kind: "agent", id: decodeURIComponent(token.slice(2)) };
  }
  if (token.startsWith("w:")) {
    return { kind: "workspace", name: decodeURIComponent(token.slice(2)) };
  }
  return undefined;
};

/** Rewrite one query param on the current path, leaving the rest. */
const withParam = (name: string, value: string | undefined): string => {
  const params = new URLSearchParams(window.location.search);
  if (value === undefined) params.delete(name);
  else params.set(name, value);
  const search = params.toString();
  return `${window.location.pathname}${search.length > 0 ? `?${search}` : ""}`;
};

export const panesFromLocation = (): ReadonlyArray<Pane> => {
  const raw = new URLSearchParams(window.location.search).get("panes");
  if (raw === null || raw.length === 0) return [];
  return raw
    .split(",")
    .map(paneOfToken)
    .filter((pane): pane is Pane => pane !== undefined);
};

const navigatePanes = (panes: ReadonlyArray<Pane>): void =>
  navigate(
    withParam(
      "panes",
      panes.length === 0 ? undefined : panes.map(paneToken).join(","),
    ),
  );

const samePane = (left: Pane, right: Pane): boolean =>
  left.kind === "agent"
    ? right.kind === "agent" && right.id === left.id
    : right.kind === "workspace" && right.name === left.name;

/** Open a pane — APPENDS a vertical split to the stack (a pane
 *  already open is left where it is). */
export const openPane = (pane: Pane): void => {
  const panes = panesFromLocation();
  if (panes.some((candidate) => samePane(candidate, pane))) return;
  navigatePanes([...panes, pane]);
};

/** Close ONE pane — its siblings keep their split. */
export const closePane = (pane: Pane): void =>
  navigatePanes(
    panesFromLocation().filter((candidate) => !samePane(candidate, pane)),
  );

export const overlayFromLocation = (): Overlay | undefined => {
  const call = new URLSearchParams(window.location.search).get("call");
  if (call !== null) return { kind: "call", id: call };
  return undefined;
};

/** Open a pane or the call modal (or close the modal with
 *  `undefined`) — history-aware, app-internal. */
export const showOverlay = (overlay: Overlay | undefined): void => {
  if (overlay === undefined) return navigate(withParam("call", undefined));
  switch (overlay.kind) {
    case "agent":
      return openPane({ kind: "agent", id: overlay.id });
    case "workspace":
      return openPane({ kind: "workspace", name: overlay.name });
    case "call":
      return navigate(withParam("call", overlay.id));
  }
};

/** Pre-path urls (`/?channel=…`, `/?task=…`) translate ONCE at boot —
 *  old links keep resolving; overlay params survive untouched. */
export const normalizeLegacyLocation = (): void => {
  const params = new URLSearchParams(window.location.search);
  // pre-pane params (`?agent=`, `?workspace=`) fold into the stack
  const agent = params.get("agent");
  const workspace = params.get("workspace");
  if (agent !== null || workspace !== null) {
    const panes: Array<string> = [];
    if (agent !== null) panes.push(`a:${encodeURIComponent(agent)}`);
    if (workspace !== null) panes.push(`w:${encodeURIComponent(workspace)}`);
    params.delete("agent");
    params.delete("workspace");
    params.set("panes", panes.join(","));
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
  }
  const task = params.get("task");
  const channel = params.get("channel");
  if (task === null && channel === null) return;
  window.history.replaceState(
    {},
    "",
    task !== null ? taskPath(task) : channelPath(channel!),
  );
};
