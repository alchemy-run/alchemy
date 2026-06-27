import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type Store as ArtifactsLike } from "./Store.ts";
import {
  ArtifactsError,
  ReadStore,
  ReadWriteStore,
  type ReadWriteStoreClient,
  type RepoClient,
  WriteStore,
} from "./ReadWriteStore.ts";

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, ArtifactsError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error: any) =>
      new ArtifactsError({
        message: error?.message ?? "Unknown error",
        cause: error,
      }),
  });

const wrapRepo = (raw: ArtifactsRepo): RepoClient => ({
  raw,
  createToken: (scope, ttl) => tryPromise(() => raw.createToken(scope, ttl)),
  listTokens: () => tryPromise(() => raw.listTokens()),
  revokeToken: (tokenOrId) => tryPromise(() => raw.revokeToken(tokenOrId)),
  fork: (name, opts) => tryPromise(() => raw.fork(name, opts)),
});

/**
 * Builds the full Artifacts client over the native worker binding. Each access
 * level (Read / Write / ReadWrite) returns this same object typed to its subset
 * — least-privilege by construction at the call site.
 */
const makeArtifactsClient = (
  env: Record<string, Artifacts>,
  artifacts: ArtifactsLike,
): ReadWriteStoreClient => {
  const raw = Effect.sync(() => env[artifacts.name]!);
  const use = <T>(
    fn: (raw: Artifacts) => Promise<T>,
  ): Effect.Effect<T, ArtifactsError> =>
    raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));
  return {
    raw,
    create: (name, opts) => use((raw) => raw.create(name, opts)),
    get: (name) =>
      use((raw) => raw.get(name)).pipe(
        Effect.flatMap((repo) =>
          repo == null
            ? Effect.fail(
                new ArtifactsError({
                  message: `Artifacts repo '${name}' not found`,
                  cause: new Error("not_found"),
                }),
              )
            : Effect.succeed(wrapRepo(repo as ArtifactsRepo)),
        ),
      ),
    list: (opts) => use((raw) => raw.list(opts)),
    delete: (name) => use((raw) => raw.delete(name)),
    import: (opts) => use((raw) => raw.import(opts)),
  };
};

const makeBinding = <Self>(tag: Self) =>
  Layer.effect(
    tag as any,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const host = yield* Worker;
      return Effect.fn(function* (artifacts: ArtifactsLike) {
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* host.bind(artifacts.name, {
            bindings: [
              {
                type: "artifacts",
                name: artifacts.name,
                namespace: artifacts.namespace,
              } as any,
            ],
          });
        }
        return makeArtifactsClient(env as Record<string, Artifacts>, artifacts);
      });
    }),
  ) as Layer.Layer<Self, never, Worker | WorkerEnvironment>;

/** Read-only Artifacts binding (`get`/`list`/`raw`). */
export const ReadStoreBinding = makeBinding(ReadStore);
/** Write Artifacts binding (`create`/`delete`/`import`). */
export const WriteStoreBinding = makeBinding(WriteStore);
/** Full read + write Artifacts binding. */
export const ReadWriteStoreBinding = makeBinding(ReadWriteStore);
