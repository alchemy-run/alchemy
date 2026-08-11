/**
 * v2 seam around the (unchanged) UIProvider registry integration in
 * `registry.ts`:
 *
 * - the registry is loaded ONCE into a module singleton and consumed via
 *   `useRegistry()` (useSyncExternalStore), so no component prop-drills it
 * - `uiCtxOf` builds a `ResourceUIContext` from a v2 `DocumentNode` +
 *   effective status; callers memoize it per node/decoration version so
 *   UIProvider hooks (summary/link/facts/Card/Details) run per CHANGE, not
 *   per render
 */
import type { DocumentMeta, DocumentNode } from "alchemy/Dashboard/Document";
import type { ResourceUIContext, UIRegistry } from "alchemy/UI/UIProvider";
import { useSyncExternalStore } from "react";
import { loadRegistry } from "./registry.ts";

let registry: UIRegistry | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Kick the one-time registry build (idempotent). */
export const ensureRegistryLoaded = (): void => {
  loading ??= loadRegistry()
    .then((r) => {
      registry = r;
      for (const listener of listeners) {
        listener();
      }
    })
    .catch((error) => {
      console.warn("dashboard: UI registry failed to load", error);
    });
};

const subscribe = (listener: () => void): (() => void) => {
  ensureRegistryLoaded();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): UIRegistry | undefined => registry;

/** The UIProvider registry, or undefined until its one-time build lands. */
export const useRegistry = (): UIRegistry | undefined =>
  useSyncExternalStore(subscribe, getSnapshot);

/**
 * Build the `ResourceUIContext` handed to UIProvider hooks from a v2
 * document node. `status` is the EFFECTIVE status
 * (`decoration?.status ?? node.status`). Callers wrap this in `useMemo`.
 */
export const uiCtxOf = (
  node: DocumentNode,
  status: string,
  meta: DocumentMeta,
): ResourceUIContext => ({
  fqn: node.fqn,
  logicalId: node.logicalId,
  type: node.type,
  status: status as ResourceUIContext["status"],
  stack: meta.stack,
  stage: meta.stage,
  props: node.props,
  attrs: node.attrs,
  bindings: node.bindings.map((b) => ({ sid: b.sid, data: b.data })),
  downstream: node.downstream,
});

/** UIProvider hooks are third-party code — never let one crash a render. */
export const safeUI = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
