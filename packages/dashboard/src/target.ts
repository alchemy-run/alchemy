/**
 * The `(stack, stage)` target as a URL query, so a hosted viewer link is
 * shareable and survives reload.
 *
 * Deliberately the query string and not the hash: the SPA is served with
 * `notFoundHandling: "single-page-application"`, so `/?stack=x&stage=y`
 * resolves to the same bundle, and the values line up 1:1 with what the
 * viewer API already accepts on every route.
 *
 * The CLI dashboard never writes here — it has exactly one target — so a
 * bare `/` keeps behaving as "whatever the server picks".
 */
import type { Target } from "./ingest.ts";

/** Read the target from `window.location` (both sides optional). */
export const targetFromLocation = (): Target => {
  const params = new URLSearchParams(window.location.search);
  const stack = params.get("stack");
  const stage = params.get("stage");
  return {
    stack: stack === null || stack === "" ? undefined : stack,
    stage: stage === null || stage === "" ? undefined : stage,
  };
};

/**
 * Mirror the target into the address bar. `replaceState` (not `push`) —
 * switching targets is a filter, not navigation, and a back button that
 * walks every stage you glanced at would be noise.
 */
export const writeTargetToLocation = (target: Target): void => {
  const params = new URLSearchParams(window.location.search);
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  };
  set("stack", target.stack);
  set("stage", target.stage);
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query === "" ? "" : `?${query}`}${window.location.hash}`,
  );
};
