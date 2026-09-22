/**
 * Module imports have to run inside the module runner Durable Object's
 * `IoContext`, but they are requested from other contexts (a Worker request,
 * a dynamic `import()`). The requesting side registers the callback here,
 * asks the object to run it over RPC by id, and reads the result by id once
 * the RPC returns. Both sides share this module because they share one V8
 * isolate.
 *
 * Every entry is removed once the caller has read its result, whether the
 * callback succeeded or failed. A result is a module namespace, and a
 * namespace keeps every module it (transitively) imported alive. Retaining
 * the results would pin each previous module graph after an HMR update or a
 * full runner reload until the isolate ran out of heap.
 */
export const makeCallbackRegistry = () => {
  let nextId = 0;
  const pending = new Map<number, () => Promise<unknown>>();
  const results = new Map<number, unknown>();
  return {
    /**
     * Registers `callback` and asks `execute` to run it under its id. Resolves
     * with the callback's result once `execute` returns.
     */
    run: async <T>(
      execute: (id: number) => Promise<void>,
      callback: () => Promise<T>,
    ): Promise<T> => {
      const id = nextId++;
      pending.set(id, callback);
      try {
        await execute(id);
        return results.get(id) as T;
      } finally {
        pending.delete(id);
        results.delete(id);
      }
    },
    /** Runs the callback registered under `id` and stores its result. */
    execute: async (id: number): Promise<void> => {
      const callback = pending.get(id);
      if (!callback) {
        throw new Error(`No pending callback with id ${id}`);
      }
      results.set(id, await callback());
    },
    /** Entries still registered. Zero whenever no `run` is in flight. */
    get size(): number {
      return pending.size + results.size;
    },
  };
};

export type CallbackRegistry = ReturnType<typeof makeCallbackRegistry>;
