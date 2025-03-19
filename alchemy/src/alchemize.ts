import { evaluate } from "./apply";
import { destroy } from "./destroy";
import { defaultStage, defaultStateStore, providers } from "./global";
import { type Scope, getScope } from "./scope";
import type { StateStoreType } from "./state";

export interface AlchemizeOptions {
  /**
   * Determines whether the resources will be created/updated or deleted.
   *
   * @default "up"
   */
  mode?: "up" | "destroy";
  /**
   * Name to scope the resource state under (e.g. `.alchemy/{stage}/..`).
   *
   * @default - your POSIX username
   */
  stage?: string;
  /**
   * If true, will not prune resources that were dropped from the root stack.
   *
   * @default true
   */
  destroyOrphans?: boolean;
  /**
   * A custom state store to use instead of the default file system store.
   */
  stateStore?: StateStoreType;
  /**
   * A custom scope to use instead of the default root scope.
   */
  scope?: Scope;
  /**
   * If true, will not print any Create/Update/Delete messages.
   *
   * @default false
   */
  quiet?: boolean;
}

/**
 * Explicitly finalize the program by deleting any resources that were dropped from the root stack.
 *
 * By default, this will be called when
 */
export async function alchemize(options?: AlchemizeOptions) {
  const scope = options?.scope ?? getScope();
  const nodes = scope.nodes;
  const stage = options?.stage ?? defaultStage;
  const stateStore = new (options?.stateStore ?? defaultStateStore)(
    scope.getScopePath(stage),
  );
  const callbacks = scope.callbacks;

  if (nodes.size > 0) {
    await stateStore.init?.();
  }

  // Track in-progress deletions to avoid duplicate work
  const deletionPromises = new Map<string, Promise<void>>();

  const priorStates = await stateStore.all();
  const priorIDs = Object.keys(priorStates);

  const mode = options?.mode ?? "up";

  if (mode === "up") {
    await Promise.allSettled(
      Array.from(nodes.values())
        .reverse()
        .map((node) =>
          evaluate(node.resource, {
            stage,
            scope,
            stateStore,
            quiet: options?.quiet,
          }),
        ),
    );

    if (options?.destroyOrphans === false) {
      return;
    }

    await Promise.all(
      callbacks.map((callback) =>
        evaluate(callback, {
          stage,
          scope,
          stateStore,
          quiet: options?.quiet,
        }),
      ),
    );
  }
  const aliveIDs = new Set(
    mode === "up"
      ? nodes.keys()
      : // There are no alive resources in destroy mode
        [],
  );

  const orphanIDs = Array.from(priorIDs).filter((id) => !aliveIDs.has(id));

  const orphanStates = Object.fromEntries(
    orphanIDs.map((id) => [id, priorStates[id]] as const),
  );
  // compute a map of resourceID -> upstream dependencies (resources that depend on it)
  const orphanGraph: Record<string, Set<string>> = {};
  for (const [orphanID, orphanState] of Object.entries(orphanStates)) {
    orphanGraph[orphanID] ??= new Set();
    for (const dep of orphanState.deps) {
      (orphanGraph[dep] ??= new Set()).add(orphanID);
    }
  }

  // Start deletion from each orphan that has no dependents (nothing depends on it)
  await Promise.all(
    orphanIDs
      .filter((id) => orphanGraph[id].size === 0)
      .map((id) => deleteOrphan(id)),
  );

  const remaining = await stateStore.count();
  if (remaining === 0) {
    await stateStore.deinit?.();
  }

  // Recursively delete orphans in dependency order
  async function deleteOrphan(orphanID: string): Promise<void> {
    // Return existing deletion promise if this orphan is already being deleted
    const existing = deletionPromises.get(orphanID);
    if (existing) {
      return existing;
    }

    // Create promise immediately to prevent race conditions
    let resolve: () => void;
    let reject: (error: any) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    deletionPromises.set(orphanID, promise);

    try {
      const orphanState = orphanStates[orphanID];

      // First delete this resource
      const providerType = orphanState.provider;
      const provider = providers.get(providerType);
      if (!provider) {
        throw new Error(
          `No provider found for ${providerType}. Did you forget to import it?`,
        );
      }
      if (!options?.quiet) {
        console.log("Destroy:", orphanID);
      }
      await destroy(stage, scope, orphanID, orphanState, provider, stateStore, {
        quiet: options?.quiet,
      });

      // After this resource is deleted, we can delete its dependencies if they're orphans
      if (orphanState.deps.length > 0) {
        await Promise.all(
          orphanState.deps
            .filter((dep) => orphanIDs.includes(dep)) // Only delete if it's an orphan
            .map((dep) => deleteOrphan(dep)),
        );
      }

      resolve!();
    } catch (error) {
      reject!(error);
    }

    return promise;
  }
}

if (process.env.ALCHEMY_NO_DEPLOY !== "true") {
  // Listen for signals or events
  process.on("exit", () => alchemize());
}
