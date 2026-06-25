import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type Artifacts as ArtifactsLike } from "./Artifacts.ts";
import {
  ArtifactsError,
  type ReadWriteStoreClient,
  type ArtifactsRepoClient,
  ReadWriteStore,
} from "./ReadWriteStore.ts";

/**
 * Implementation of the {@link ReadWriteStore} binding that uses a Worker
 * binding. Registers the `artifacts` binding on the host Worker at deploy time,
 * then exposes the Effect-native client.
 */
export const ReadWriteStoreBinding = Layer.effect(
  ReadWriteStore,
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
      const raw = Effect.sync(
        () => (env as Record<string, Artifacts>)[artifacts.name]!,
      );

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
      } satisfies ReadWriteStoreClient;
    });
  }),
);

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

const wrapRepo = (raw: ArtifactsRepo): ArtifactsRepoClient => ({
  raw,
  createToken: (scope, ttl) => tryPromise(() => raw.createToken(scope, ttl)),
  listTokens: () => tryPromise(() => raw.listTokens()),
  revokeToken: (tokenOrId) => tryPromise(() => raw.revokeToken(tokenOrId)),
  fork: (name, opts) => tryPromise(() => raw.fork(name, opts)),
});
