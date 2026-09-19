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

/* ── the app's TOP TABS: Chat | Code | Issues | Pulls | Tasks ─────── */

export type AppTab = "chat" | "code" | "issues" | "pulls" | "tasks";

/** Which top tab the path lives under — every chat-era path is Chat. */
export const tabFromLocation = (): AppTab => {
  const head = segments()[0];
  return head === "code" ||
    head === "issues" ||
    head === "pulls" ||
    head === "tasks"
    ? head
    : "chat";
};

export interface CodePlace {
  readonly repo: string;
  readonly ref: string;
  /** Directory or file path inside the tree ("" = the root). */
  readonly path: string;
}

/** `/code/:repo[/:ref[/*path]]` — the forge's code browser. */
export const codePath = (
  repo = "alchemy",
  ref = "main",
  path = "",
): string =>
  `/code/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}` +
  (path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`);

export const codeFromLocation = (): CodePlace => {
  const parts = segments();
  return {
    repo: parts[1] === undefined ? "alchemy" : decodeURIComponent(parts[1]),
    ref: parts[2] === undefined ? "main" : decodeURIComponent(parts[2]),
    path: parts.slice(3).map(decodeURIComponent).join("/"),
  };
};

export const showCode = (repo?: string, ref?: string, path?: string): void =>
  navigate(codePath(repo, ref, path));

export interface WorkPlace {
  readonly repo: string;
  /** The open item's number — undefined on the list. */
  readonly number?: number;
}

/** `/issues/:repo[/:number]` and `/pulls/:repo[/:number]`. */
export const workPath = (
  tab: "issues" | "pulls",
  repo = "alchemy",
  number?: number,
): string =>
  `/${tab}/${encodeURIComponent(repo)}${number === undefined ? "" : `/${number}`}`;

export const workFromLocation = (): WorkPlace => {
  const parts = segments();
  const number = Number(parts[2]);
  return {
    repo: parts[1] === undefined ? "alchemy" : decodeURIComponent(parts[1]),
    number: Number.isFinite(number) && number > 0 ? number : undefined,
  };
};

export const showWork = (
  tab: "issues" | "pulls",
  repo?: string,
  number?: number,
): void => navigate(workPath(tab, repo, number));

export interface TasksPlace {
  /** The queue slug — undefined lands on the first registered queue. */
  readonly queue?: string;
  /** The open task's id — undefined on the board. */
  readonly task?: string;
  /** The open desk's member slug (`/tasks/:queue/desks/:agent`). */
  readonly desk?: string;
}

/** `/tasks[/:queue[/:id]]` — the board, or one task's page. */
export const tasksPath = (queue?: string, id?: string): string =>
  queue === undefined
    ? "/tasks"
    : `/tasks/${encodeURIComponent(queue)}${
        id === undefined ? "" : `/${encodeURIComponent(id)}`
      }`;

/** `/tasks/:queue/desks/:agent` — one desk's standing session. */
export const deskPath = (queue: string, agent: string): string =>
  `/tasks/${encodeURIComponent(queue)}/desks/${encodeURIComponent(agent)}`;

export const tasksFromLocation = (): TasksPlace => {
  const parts = segments();
  if (parts[0] !== "tasks" || parts[1] === undefined) return {};
  const queue = decodeURIComponent(parts[1]);
  if (parts[2] === "desks" && parts[3] !== undefined) {
    return { queue, desk: decodeURIComponent(parts[3]) };
  }
  return {
    queue,
    ...(parts[2] === undefined ? {} : { task: decodeURIComponent(parts[2]) }),
  };
};

export const showTasks = (queue?: string, id?: string): void =>
  navigate(tasksPath(queue, id));

export const showDesk = (queue: string, agent: string): void =>
  navigate(deskPath(queue, agent));

/** Chat remembers its place across tab hops (module state is enough —
 *  a reload lands on the tab the URL names). */
let lastChatPath = "/";
export const rememberChatPath = (): void => {
  lastChatPath = window.location.pathname + window.location.search;
};
export const showChat = (): void => navigate(lastChatPath);

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

/** The profile's TABS — the charter is the page; skills and tools
 *  are its two indexes; permissions is what all of it can reach;
 *  self is what the agent has learned (its digest, journal, and
 *  generation chain). */
export type AgentTab = "charter" | "skills" | "tools" | "permissions" | "self";

const TABS: ReadonlySet<string> = new Set([
  "skills",
  "tools",
  "permissions",
  "self",
]);

export interface AgentPlace {
  readonly name: string;
  readonly tab: AgentTab;
  /** The selected item on the tab — a skill or tool name. */
  readonly item?: string;
}

/** An agent's PROFILE — the mirror of its charter (`/a/Head`), with
 *  the tab and selection in the path (`/a/Head/tools/explore`) so a
 *  pill click anywhere deep-links to the exact card. */
export const agentPath = (
  name: string,
  tab: AgentTab = "charter",
  item?: string,
): string =>
  `/a/${encodeURIComponent(name)}` +
  (tab === "charter"
    ? ""
    : `/${tab}${item === undefined ? "" : `/${encodeURIComponent(item)}`}`);

export const agentFromLocation = (): AgentPlace | undefined => {
  const parts = segments();
  if (parts[0] !== "a" || parts[1] === undefined) return undefined;
  const tab =
    parts[2] !== undefined && TABS.has(parts[2])
      ? (parts[2] as AgentTab)
      : "charter";
  return {
    name: decodeURIComponent(parts[1]),
    tab,
    item:
      tab !== "charter" && parts[3] !== undefined
        ? decodeURIComponent(parts[3])
        : undefined,
  };
};

export const showAgent = (
  name: string,
  tab: AgentTab = "charter",
  item?: string,
): void => navigate(agentPath(name, tab, item));

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
  | { readonly kind: "workspace"; readonly name: string }
  /** A THREAD opened from a message reference — `id` is the thread's
   *  root post. Reference clicks always land here, right-adjacent to
   *  wherever the click happened; the chain only ever grows. */
  | { readonly kind: "post"; readonly channel: string; readonly id: string };

const paneToken = (pane: Pane): string =>
  pane.kind === "agent"
    ? `a:${encodeURIComponent(pane.id)}`
    : pane.kind === "workspace"
      ? `w:${encodeURIComponent(pane.name)}`
      : `p:${encodeURIComponent(pane.channel)}:${encodeURIComponent(pane.id)}`;

const paneOfToken = (token: string): Pane | undefined => {
  if (token.startsWith("a:")) {
    return { kind: "agent", id: decodeURIComponent(token.slice(2)) };
  }
  if (token.startsWith("w:")) {
    return { kind: "workspace", name: decodeURIComponent(token.slice(2)) };
  }
  if (token.startsWith("p:")) {
    const at = token.indexOf(":", 2);
    if (at === -1) return undefined;
    return {
      kind: "post",
      channel: decodeURIComponent(token.slice(2, at)),
      id: decodeURIComponent(token.slice(at + 1)),
    };
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
    : left.kind === "workspace"
      ? right.kind === "workspace" && right.name === left.name
      : right.kind === "post" &&
        right.channel === left.channel &&
        right.id === left.id;

/** Open a pane — a NEW split in the stack, never displacing one: a
 *  pane already open is left exactly where it is. With `after`, the
 *  split lands right-adjacent to the pane the click came from (the
 *  reference-chain move); without it, at the stack's end. The
 *  user's chain is never blown away — it only grows. */
export const openPane = (pane: Pane, options?: { after?: Pane }): void => {
  const panes = panesFromLocation();
  if (panes.some((candidate) => samePane(candidate, pane))) return;
  const at =
    options?.after === undefined
      ? -1
      : panes.findIndex((candidate) => samePane(candidate, options.after!));
  navigatePanes(
    at === -1
      ? [...panes, pane]
      : [...panes.slice(0, at + 1), pane, ...panes.slice(at + 1)],
  );
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

/** Pre-path urls (`/?channel=…`) translate ONCE at boot — old links
 *  keep resolving; overlay params survive untouched. */
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
  const channel = params.get("channel");
  if (channel === null) return;
  window.history.replaceState({}, "", channelPath(channel));
};
