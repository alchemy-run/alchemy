import * as Binding from "alchemy/Binding";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Shared from "alchemy/RuntimeObjects";
import * as Effect from "effect/Effect";
import { DictsOps, makeDictsClient } from "./CreateDictHttp.ts";
import { makeQueuesClient, QueuesOps } from "./CreateQueueHttp.ts";
import { makeSecretsClient, SecretsOps } from "./CreateSecretHttp.ts";
import { makeVolumesClient, VolumesOps } from "./CreateVolumeHttp.ts";
import type { Environment } from "./Environment.ts";
import { environmentNames } from "./internal.ts";
import type { Providers } from "./Providers.ts";

/** What happens to objects a runtime created when the stack is destroyed. */
export type OnDestroy = Shared.OnDestroy;

/** Kinds of object the `Create*` bindings create at runtime. */
export type RuntimeObjectKind = "volume" | "dict" | "queue" | "secret";

/** Options of the `Create*` bindings. */
export interface CreateOptions {
  /**
   * `"delete"` removes every object this runtime created when the stack is
   * destroyed; `"retain"` leaves them (user data in production, say).
   * @default "delete"
   */
  readonly onDestroy?: OnDestroy;
}

export type RuntimeObjectsProps = Shared.RuntimeObjectsProps<RuntimeObjectKind>;
export type RuntimeObjectsAttributes = Shared.RuntimeObjectsAttributes<RuntimeObjectKind>;

/**
 * The volumes, dicts, queues or secrets one runtime creates by name with a
 * `Create*` binding. Modal objects carry only a name, so each is stamped
 * with this resource's prefix (`<prefix>-<name>`), and destroying it deletes
 * every stamped object, in every environment, unless `onDestroy` is
 * `"retain"`. The `Create*` bindings declare it for their runtime; you don't
 * declare it yourself.
 *
 * @resource
 * @product Volume
 */
export const RuntimeObjects = Resource<RuntimeObjects>("Modal.RuntimeObjects");

export type RuntimeObjects = Resource<
  "Modal.RuntimeObjects",
  RuntimeObjectsProps,
  RuntimeObjectsAttributes,
  never,
  Providers
>;

/** The name a stamped object gets. */
export const stampedName = (prefix: string | undefined, name: string) =>
  prefix === undefined ? name : Shared.runtimeName(prefix, name);

/** A stamped object's name without the prefix, or `undefined` when it isn't stamped with it. */
export const unstampedName = (prefix: string | undefined, name: string) =>
  prefix === undefined
    ? name
    : name.startsWith(`${prefix}-`)
      ? name.slice(prefix.length + 1)
      : undefined;

/**
 * The prefix a `Create*` binding stamps on the objects it creates. Yield it
 * while the binding's layer is built; the returned function, called per
 * binding, declares the runtime's {@link RuntimeObjects} at deploy and binds
 * its prefix into the runtime's env, and its Effect reads the prefix back at
 * runtime. Without a runtime (a script or an Action), names aren't stamped.
 */
export const RuntimeStamp = Effect.gen(function* () {
  // Deploy only: a runtime bundle never declares the resource.
  const Objects = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RuntimeObjects;
  return Effect.fn(function* (
    kind: RuntimeObjectKind,
    environment: Environment | undefined,
    options: CreateOptions | undefined,
  ) {
    const runtime = yield* CurrentRuntimeContext;
    if (runtime === undefined) return Effect.undefined;
    const scope = environment === undefined ? "" : `_${sanitizeKey(environment.LogicalId)}`;
    const key = `MODAL_${kind.toUpperCase()}_PREFIX${scope.toUpperCase()}`;
    if (Objects !== undefined) {
      const host = yield* Binding.Host;
      if (host !== undefined) {
        const kindName = `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
        const objects = yield* Objects(
          `${host.LogicalId}${kindName}Objects${environment?.LogicalId ?? ""}`,
          { kinds: [kind], onDestroy: options?.onDestroy },
        );
        yield* runtime.set(key, objects.prefix);
      }
    }
    return runtime.get<string>(key);
  });
});

/** Delete every object of `kind` in `environment` stamped with `prefix`. */
export const sweepRuntimeObjects = Effect.fn(function* (
  kind: RuntimeObjectKind,
  environment: string | undefined,
  prefix: string,
) {
  const env = Effect.succeed(environment);
  const stamp = Effect.succeed<string | undefined>(prefix);
  const sweep = <E>(client: {
    readonly list: () => Effect.Effect<ReadonlyArray<string>, E>;
    readonly delete: (name: string) => Effect.Effect<void, E>;
  }) =>
    Effect.flatMap(client.list(), (names) =>
      Effect.forEach(names, (name) => client.delete(name), { concurrency: 4, discard: true }),
    );
  switch (kind) {
    case "volume":
      return yield* sweep(makeVolumesClient(env, yield* VolumesOps, stamp));
    case "dict":
      return yield* sweep(makeDictsClient(env, yield* DictsOps, stamp));
    case "queue":
      return yield* sweep(makeQueuesClient(env, yield* QueuesOps, stamp));
    case "secret":
      return yield* sweep(makeSecretsClient(env, yield* SecretsOps, stamp));
  }
});

/**
 * Delete every object a {@link RuntimeObjects} stamped: its kinds, in every
 * environment of the workspace (the prefix is unique to one runtime).
 */
export const sweepStamped = Effect.fn(function* (attrs: RuntimeObjectsAttributes) {
  const environments = yield* environmentNames;
  yield* Effect.forEach(
    environments,
    (environment) =>
      Effect.forEach(attrs.kinds, (kind) => sweepRuntimeObjects(kind, environment, attrs.prefix), {
        discard: true,
      }),
    { concurrency: 4, discard: true },
  );
});

export const RuntimeObjectsProvider = () =>
  Provider.effect(RuntimeObjects, Effect.succeed(Shared.lifecycle(sweepStamped)));
