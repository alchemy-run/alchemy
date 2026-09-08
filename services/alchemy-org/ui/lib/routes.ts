/**
 * The app's URLs — the channel is home, threads are pages, and a
 * thread's review/terminal are sub-paths. Nothing else routes.
 *
 * ```
 * /                                         the channel
 * /threads/{id}                             a thread (its conversation)
 * /threads/{id}/{owner}/{repo}/pull/{n}     … a pull request's review
 * /threads/{id}/terminal/{pty}              … a terminal on its machine
 * ```
 */

/** What a thread page is showing beside (or instead of) its chat. */
export type ThreadTab =
  | { kind: "chat" }
  | { kind: "review"; owner: string; repo: string; number: number }
  | { kind: "terminal"; pty: string };

export type Route =
  | { kind: "channel" }
  | { kind: "thread"; id: string; tab: ThreadTab };

/** A path segment — only characters a path can't carry get escaped,
 *  so everyday `t-do-init-4f2a` names print verbatim. */
const segment = (value: string): string =>
  encodeURIComponent(value).replace(/%40/g, "@").replace(/%3A/gi, ":");

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export const CHANNEL_PATH = "/";

export const threadPath = (id: string): string => `/threads/${segment(id)}`;

export const reviewPath = (
  id: string,
  owner: string,
  repo: string,
  number: number,
): string =>
  `${threadPath(id)}/${segment(owner)}/${segment(repo)}/pull/${number}`;

export const terminalPath = (id: string, pty: string): string =>
  `${threadPath(id)}/terminal/${segment(pty)}`;

export const pathOf = (route: Route): string => {
  if (route.kind === "channel") return CHANNEL_PATH;
  switch (route.tab.kind) {
    case "chat":
      return threadPath(route.id);
    case "review":
      return reviewPath(
        route.id,
        route.tab.owner,
        route.tab.repo,
        route.tab.number,
      );
    case "terminal":
      return terminalPath(route.id, route.tab.pty);
  }
};

/** The route a path names. Junk routes home (the channel). */
export const routeOf = (pathname: string): Route => {
  const parts = pathname.split("/").filter(Boolean).map(decode);
  if (parts[0] !== "threads" || parts[1] === undefined) {
    return { kind: "channel" };
  }
  const id = parts[1];
  const rest = parts.slice(2);
  if (rest.length === 0) return { kind: "thread", id, tab: { kind: "chat" } };
  if (rest.length === 2 && rest[0] === "terminal") {
    return { kind: "thread", id, tab: { kind: "terminal", pty: rest[1]! } };
  }
  if (rest.length === 4 && rest[2] === "pull" && /^\d+$/.test(rest[3]!)) {
    return {
      kind: "thread",
      id,
      tab: {
        kind: "review",
        owner: rest[0]!,
        repo: rest[1]!,
        number: Number(rest[3]),
      },
    };
  }
  return { kind: "thread", id, tab: { kind: "chat" } };
};

export const routeFromLocation = (): Route =>
  routeOf(window.location.pathname);

/** Fired on `window` after every in-app `navigate` — `pushState` is
 *  silent, and mounted views need to hear the location change the way
 *  they hear `popstate`. */
export const NAVIGATE_EVENT = "alchemy:navigate";

/** Navigate (pushState, same document) unless already there. */
export const navigate = (path: string): void => {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
};
