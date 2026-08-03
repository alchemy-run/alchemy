/**
 * The dashboard's URL contract.
 *
 * ```
 * /                          index — pick a stack (hosted viewer only)
 * /stacks/:stack             a stack, server-default stage
 * /stacks/:stack/:stage      a stack + stage
 * ```
 *
 * Paths rather than query params: the target IS the page, so it belongs
 * in the path, and both hosts already fall back to `index.html` for
 * unknown paths (the CLI server's SPA fallback; the Worker's
 * `notFoundHandling: "single-page-application"`), so deep links load.
 *
 * The API stays query-shaped (`?stack=&stage=`) — that is the right shape
 * for an API, and only browser URLs move.
 *
 * Hand-rolled rather than a router dependency: two routes do not justify
 * one, and this package ships with no runtime dependencies.
 */

export type Route =
  | { kind: "index" }
  | { kind: "target"; stack: string; stage: string | undefined };

/** Build the canonical path for a target. */
export const pathOf = (target: {
  stack: string;
  stage?: string | undefined;
}): string =>
  target.stage === undefined
    ? `/stacks/${encodeURIComponent(target.stack)}`
    : `/stacks/${encodeURIComponent(target.stack)}/${encodeURIComponent(target.stage)}`;

/**
 * Parse a path (plus optional query) into a route.
 *
 * `?stack=`/`?stage=` are still honoured so links minted before paths
 * existed keep working; `parse` reports them as a normal target and the
 * caller rewrites the URL to the path form.
 */
export const parseRoute = (pathname: string, search = ""): Route => {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] === "stacks" && segments[1] !== undefined) {
    return {
      kind: "target",
      stack: decodeURIComponent(segments[1]),
      stage:
        segments[2] === undefined ? undefined : decodeURIComponent(segments[2]),
    };
  }
  // legacy query form
  const params = new URLSearchParams(search);
  const stack = params.get("stack");
  if (stack !== null && stack !== "") {
    const stage = params.get("stage");
    return {
      kind: "target",
      stack,
      stage: stage === null || stage === "" ? undefined : stage,
    };
  }
  return { kind: "index" };
};

/** The route the browser is currently on. */
export const currentRoute = (): Route =>
  parseRoute(window.location.pathname, window.location.search);

const LISTENERS = new Set<() => void>();

const notify = (): void => {
  for (const listener of LISTENERS) {
    listener();
  }
};

/**
 * Navigate to a path. A real `pushState` (not `replaceState`) so the back
 * button walks the stacks you visited — switching targets IS navigation
 * here, unlike a filter.
 */
export const navigate = (path: string): void => {
  if (path === `${window.location.pathname}${window.location.search}`) {
    return;
  }
  window.history.pushState(null, "", path);
  notify();
};

/** Rewrite the current URL in place (legacy-query → path canonicalization). */
export const replaceRoute = (path: string): void => {
  window.history.replaceState(null, "", path);
  notify();
};

/** Subscribe to route changes (back/forward included). */
export const subscribeRoute = (listener: () => void): (() => void) => {
  LISTENERS.add(listener);
  if (LISTENERS.size === 1) {
    window.addEventListener("popstate", notify);
  }
  return () => {
    LISTENERS.delete(listener);
    if (LISTENERS.size === 0) {
      window.removeEventListener("popstate", notify);
    }
  };
};
