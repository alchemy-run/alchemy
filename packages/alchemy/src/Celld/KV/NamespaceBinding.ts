import { storageBinding } from "./StorageBinding.ts";
import type { NativeNamespace } from "./NamespaceTypes.ts";
import * as Effect from "effect/Effect";
import { Worker } from "../Worker.ts";
import { WorkerEnvironment } from "../../Workers/Worker.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceError } from "./NamespaceTypes.ts";

/**
 * Shared scaffolding for the Worker-binding implementations of the KV
 * services.
 *
 * Resolves the {@link WorkerEnvironment} and host {@link Worker}, registers
 * the `kv_namespace` binding at deploy time, then delegates to `makeClient`
 * with the shared {@link makeKVNamespaceHelpers} to build the
 * read/write/read-write client.
 */
export const makeKVNamespaceBinding = <Client>(options: {
  makeClient: (helpers: ReturnType<typeof makeKVNamespaceHelpers>) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (namespace: Namespace) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${namespace}`({
          storageBindings: [storageBinding(namespace)],
          bindings: [
            {
              type: "kv_namespace",
              name: namespace.LogicalId,
              namespaceId: namespace.namespaceId,
            },
          ],
        });
      }

      return options.makeClient(makeKVNamespaceHelpers(env, namespace));
    });
  });

/** Primitives shared by the read and write halves of the binding client. */
export const makeKVNamespaceHelpers = (
  env: Record<string, unknown>,
  namespace: Pick<Namespace, "LogicalId">,
) => {
  const raw = Effect.suspend(() => {
    const binding = env[namespace.LogicalId] as NativeNamespace | undefined;
    return binding
      ? Effect.succeed(binding)
      : Effect.fail(
          new NamespaceError({
            message: `Missing Celld KV binding '${namespace.LogicalId}'`,
            cause: undefined,
          }),
        );
  });

  const tryPromise = <T>(
    fn: () => Promise<T>,
  ): Effect.Effect<T, NamespaceError> =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) =>
        new NamespaceError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  const use = <T>(fn: (raw: NativeNamespace) => Promise<T>) =>
    raw.pipe(Effect.flatMap((binding) => tryPromise(() => fn(binding))));

  return { raw, use, tryPromise };
};
