/**
 * The app's URLs — GitHub-shaped paths, no hash, nothing percent-encoded
 * in the common case:
 *
 * ```
 * /                                              home (Code, nothing selected)
 * /pulls                                         Review, nothing selected
 * /{owner}/{repo}/pull/{n}                       a PR's overview
 * /{owner}/{repo}/pull/{n}/review                the bot's review session
 * /{owner}/{repo}/pull/{n}/threads/{thread}      an engineer thread on the PR
 * /{owner}/{repo}/sessions/{name}                a coding session
 * /{owner}/{repo}/sessions/{name}/threads/{t}    one of its threads
 * /sessions/{name}[/threads/{t}]                 a legacy, repo-less session
 * ```
 *
 * VIEW IDS stay what the server speaks — chat ids (`Engineer:…`,
 * `Reviewer:…`) plus the synthetic `pr:<owner>/<repo>#<n>` overview —
 * and the two functions below are the only translation: {@link pathOf}
 * renders an id as a path, {@link viewOf} reads one back. Legacy
 * `#<encoded id>` hashes still resolve (see {@link viewFromLocation}),
 * so old bookmarks land, then get rewritten in place.
 */

/** A thread key is `<session>[::<thread>]`. */
export const splitThreadKey = (
  key: string,
): { session: string; thread: string | undefined } => {
  const at = key.indexOf("::");
  return at < 0
    ? { session: key, thread: undefined }
    : { session: key.slice(0, at), thread: key.slice(at + 2) };
};

/** A pull-request session key (`owner/repo#N`)? */
export const isPullSession = (session: string): boolean =>
  /#\d+$/.test(session);

/** `owner/repo#N` → N. */
export const pullNumberOf = (session: string): number =>
  Number(session.match(/#(\d+)$/)?.[1]);

/** The overview view id of a PR session. */
export const overviewId = (session: string): string => `pr:${session}`;

/** The session key a view id belongs to (`undefined` for unknown ids). */
export const sessionOfId = (id: string | undefined): string | undefined => {
  if (id === undefined) return undefined;
  if (id.startsWith("Engineer:")) {
    return splitThreadKey(id.slice("Engineer:".length)).session;
  }
  if (id.startsWith("Reviewer:")) {
    return splitThreadKey(id.slice("Reviewer:".length)).session;
  }
  if (id.startsWith("pr:")) return id.slice("pr:".length);
  return undefined;
};

/** Is this string one of the view ids the app routes to? */
export const isViewId = (raw: string): boolean =>
  raw.startsWith("Engineer:") ||
  raw.startsWith("Reviewer:") ||
  raw.startsWith("pr:");

/** `owner/repo#N` → its parts (`undefined` when not a PR key). */
const parsePull = (
  session: string,
): { owner: string; repo: string; number: number } | undefined => {
  const match = session.match(/^([^/#]+)\/([^/#]+)#(\d+)$/);
  return match === null
    ? undefined
    : { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
};

/** A path segment — only characters a path can't carry get escaped, so
 *  the everyday `s-4f2a` / `t-9c1d` names print verbatim. */
const segment = (value: string): string =>
  encodeURIComponent(value).replace(/%40/g, "@").replace(/%3A/gi, ":");

const threadSuffix = (thread: string | undefined): string =>
  thread === undefined ? "" : `/threads/${segment(thread)}`;

/** The base path of a session key: PR keys become `/o/r/pull/n`,
 *  repo-scoped coding keys `/o/r/sessions/name`, anything else (the
 *  legacy repo-less `main` / `t-…`) `/sessions/name`. */
const sessionPath = (session: string): string => {
  const pull = parsePull(session);
  if (pull !== undefined) {
    return `/${segment(pull.owner)}/${segment(pull.repo)}/pull/${pull.number}`;
  }
  const parts = session.split("/");
  if (parts.length >= 3) {
    const [owner, repo, ...name] = parts;
    return `/${segment(owner!)}/${segment(repo!)}/sessions/${name
      .map(segment)
      .join("/")}`;
  }
  return `/sessions/${parts.map(segment).join("/")}`;
};

/** The URL path of a view id. Unknown ids route home. */
export const pathOf = (id: string | undefined): string => {
  if (id === undefined) return "/";
  if (id.startsWith("pr:")) return sessionPath(id.slice("pr:".length));
  if (id.startsWith("Reviewer:")) {
    const { session, thread } = splitThreadKey(id.slice("Reviewer:".length));
    return `${sessionPath(session)}/review${threadSuffix(thread)}`;
  }
  if (id.startsWith("Engineer:")) {
    const { session, thread } = splitThreadKey(id.slice("Engineer:".length));
    const base = sessionPath(session);
    // an engineer thread ON a pull request lives under the PR
    return isPullSession(session)
      ? `${base}/threads${thread === undefined ? "" : `/${segment(thread)}`}`
      : `${base}${threadSuffix(thread)}`;
  }
  return "/";
};

/** The Review activity's empty-state path. */
export const PULLS_PATH = "/pulls";

/** The PR overview's tabs. `conversation` is the bare PR path; the
 *  others are a trailing segment (`/files`, `/proposals`), as GitHub
 *  does with `/files`. */
export type OverviewTab = "conversation" | "files" | "proposals";

const TAB_SEGMENTS: ReadonlyArray<Exclude<OverviewTab, "conversation">> = [
  "files",
  "proposals",
];

const TAB_SUFFIX = /\/(files|proposals)$/;

/** Which overview tab a PR path shows (`conversation` for the bare
 *  path, and for anything that is not a PR path). */
export const tabOf = (pathname: string): OverviewTab => {
  const match = /\/pull\/\d+\/(files|proposals)$/.exec(pathname);
  return match === null ? "conversation" : (match[1] as OverviewTab);
};

/** The overview tab the location shows. */
export const tabFromLocation = (): OverviewTab =>
  tabOf(window.location.pathname);

/** A PR overview path switched to `tab`. */
export const withTab = (pathname: string, tab: OverviewTab): string => {
  const base = pathname.replace(TAB_SUFFIX, "");
  return tab === "conversation" ? base : `${base}/${tab}`;
};

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** `name/segments[/threads/t]` → the key `name[::t]`. */
const keyOf = (session: string, rest: string[]): string | undefined => {
  if (rest.length === 0) return session;
  if (rest.length === 2 && rest[0] === "threads") return `${session}::${rest[1]}`;
  return undefined;
};

/** Split `[...name, "threads", t]` into the name segments and the
 *  thread — a session name may itself carry slashes. */
const takeSession = (
  parts: string[],
): { name: string[]; rest: string[] } | undefined => {
  const at = parts.indexOf("threads");
  const name = at < 0 ? parts : parts.slice(0, at);
  if (name.length === 0) return undefined;
  return { name, rest: at < 0 ? [] : parts.slice(at) };
};

/** The view id a path names, or `undefined` (home, `/pulls`, junk). */
export const viewOf = (pathname: string): string | undefined => {
  const parts = pathname.split("/").filter(Boolean).map(decode);
  if (parts.length === 0) return undefined;
  if (parts[0] === "sessions") {
    const taken = takeSession(parts.slice(1));
    if (taken === undefined) return undefined;
    const key = keyOf(taken.name.join("/"), taken.rest);
    return key === undefined ? undefined : `Engineer:${key}`;
  }
  if (parts.length < 4) return undefined;
  const [owner, repo, kind, ...tail] = parts;
  if (kind === "pull") {
    const [number, ...rest] = tail;
    if (!/^\d+$/.test(number!)) return undefined;
    const session = `${owner}/${repo}#${number}`;
    if (rest.length === 0) return overviewId(session);
    // the overview's tabs are the same view, on their GitHub-shaped
    // paths; the overview reads the tab off the location
    if (
      rest.length === 1 &&
      TAB_SEGMENTS.includes(rest[0] as Exclude<OverviewTab, "conversation">)
    ) {
      return overviewId(session);
    }
    if (rest[0] === "review") {
      if (rest.length === 1) return `Reviewer:${session}`;
      if (rest.length === 3 && rest[1] === "threads") {
        return `Reviewer:${session}::${rest[2]}`;
      }
      return undefined;
    }
    if (rest[0] === "threads") {
      if (rest.length === 1) return `Engineer:${session}`;
      if (rest.length === 2) return `Engineer:${session}::${rest[1]}`;
      return undefined;
    }
    return undefined;
  }
  if (kind === "sessions") {
    const taken = takeSession(tail);
    if (taken === undefined) return undefined;
    const key = keyOf(`${owner}/${repo}/${taken.name.join("/")}`, taken.rest);
    return key === undefined ? undefined : `Engineer:${key}`;
  }
  return undefined;
};

/** What the current location names: a view id, or nothing. A legacy
 *  `#<encoded id>` hash wins over the path and is rewritten to its
 *  path in place, so old links keep working and stop looking old. */
export const viewFromLocation = (): string | undefined => {
  const hash = decode(window.location.hash.slice(1));
  if (hash !== "" && isViewId(hash)) {
    window.history.replaceState(null, "", pathOf(hash));
    return hash;
  }
  return viewOf(window.location.pathname);
};

/** Is the location the Review activity's empty state? */
export const isPullsLocation = (): boolean =>
  window.location.pathname === PULLS_PATH;

/** Navigate (pushState, same document) unless already there. */
/** Fired on `window` after every in-app `navigate` — `pushState` is
 *  silent, and a mounted view (a PR's overview keeping its tab) needs
 *  to hear the location change the way it hears `popstate`. */
export const NAVIGATE_EVENT = "alchemy:navigate";

export const navigate = (path: string): void => {
  if (window.location.pathname + window.location.hash === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
};
