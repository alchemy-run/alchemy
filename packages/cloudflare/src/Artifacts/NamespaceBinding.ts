import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Namespace } from "./Namespace.ts";
import {
  CreateRepoErrorCodes,
  CreateTokenErrorCodes,
  DeleteRepoErrorCodes,
  ForkRepoErrorCodes,
  GetRepoErrorCodes,
  ImportRepoErrorCodes,
  ListReposErrorCodes,
  ListTokensErrorCodes,
  type NativeArtifacts,
  type NativeArtifactsRepo,
  ReadBytesErrorCodes,
  ReadObjectErrorCodes,
  RepoInfoErrorCodes,
  RevokeTokenErrorCodes,
  tryArtifacts,
} from "./NamespaceTypes.ts";
import type { ReadNamespaceClient, ReadRepoClient } from "./ReadNamespace.ts";
import type { RepoClient } from "./ReadWriteNamespace.ts";
import type { WriteNamespaceClient, WriteRepoClient } from "./WriteNamespace.ts";

/**
 * Shared scaffolding for the Worker-binding implementations of the Artifacts
 * services (NOT exported from the service index).
 *
 * Resolves the {@link WorkerEnvironment} and host {@link Worker}, registers the
 * native `artifacts` binding at deploy time, then delegates to `makeClient`
 * with the shared {@link makeArtifactsHelpers}.
 */
export const makeArtifactsBinding = <Client>(options: {
  makeClient: (helpers: ArtifactsHelpers) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;
    return Effect.fn(function* (namespace: Namespace) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind(namespace.name, {
          bindings: [
            {
              type: "artifacts",
              name: namespace.name,
              namespace: namespace.namespace,
            } as any,
          ],
        });
      }
      return options.makeClient(makeArtifactsHelpers(env as Record<string, unknown>, namespace));
    });
  });

export type ArtifactsHelpers = ReturnType<typeof makeArtifactsHelpers>;

/** Primitives shared by the read and write halves of the binding client. */
export const makeArtifactsHelpers = (env: Record<string, unknown>, namespace: Namespace) => {
  // Lazy — the WorkerEnvironment binding is not populated until runtime.
  const raw = Effect.sync(() => env[namespace.name] as NativeArtifacts);
  const openRepo = (name: string) =>
    raw.pipe(
      Effect.flatMap((artifacts) => tryArtifacts(() => artifacts.get(name), GetRepoErrorCodes)),
    );
  return { raw, openRepo };
};

/** Effect-native read half of a repository handle. */
export const makeReadRepoClient = (name: string, repo: NativeArtifactsRepo): ReadRepoClient => ({
  name,
  raw: repo,
  info: () => tryArtifacts(() => repo.info(), RepoInfoErrorCodes),
  listTokens: () => tryArtifacts(() => repo.listTokens(), ListTokensErrorCodes),
  log: (opts) => tryArtifacts(() => repo.log(opts), ReadObjectErrorCodes),
  readCommit: (hash) => tryArtifacts(() => repo.readCommit(hash), ReadObjectErrorCodes),
  readTree: (hash) => tryArtifacts(() => repo.readTree(hash), ReadObjectErrorCodes),
  readBlob: (hash) => tryArtifacts(() => repo.readBlob(hash), ReadBytesErrorCodes),
  readFile: (args) => tryArtifacts(() => repo.readFile(args), ReadBytesErrorCodes),
  dispose: () => disposeRepo(repo),
});

/** Effect-native write half of a repository handle. */
export const makeWriteRepoClient = (name: string, repo: NativeArtifactsRepo): WriteRepoClient => ({
  name,
  raw: repo,
  createToken: (scope, ttl) =>
    tryArtifacts(() => repo.createToken(scope, ttl), CreateTokenErrorCodes),
  revokeToken: (tokenOrId) =>
    tryArtifacts(() => repo.revokeToken(tokenOrId), RevokeTokenErrorCodes),
  fork: (target, opts) => tryArtifacts(() => repo.fork(target, opts), ForkRepoErrorCodes),
  dispose: () => disposeRepo(repo),
});

/** Full read + write repository handle. */
export const makeRepoClient = (name: string, repo: NativeArtifactsRepo): RepoClient => ({
  ...makeReadRepoClient(name, repo),
  ...makeWriteRepoClient(name, repo),
});

const disposeRepo = (repo: NativeArtifactsRepo) =>
  Effect.sync(() => {
    try {
      repo[Symbol.dispose]?.();
    } catch {
      // already released
    }
  });

/** Read-only namespace client over the native binding. */
export const makeReadNamespaceClient = ({
  raw,
  openRepo,
}: ArtifactsHelpers): ReadNamespaceClient => {
  const list: ReadNamespaceClient["list"] = (opts) =>
    raw.pipe(
      Effect.flatMap((artifacts) => tryArtifacts(() => artifacts.list(opts), ListReposErrorCodes)),
    );
  return {
    raw,
    get: (name) => openRepo(name).pipe(Effect.map((repo) => makeReadRepoClient(name, repo))),
    list,
    listAll: (opts) =>
      Stream.paginate(undefined as string | undefined, (cursor) =>
        list({ limit: opts?.limit, cursor }).pipe(
          Effect.map(
            (page) =>
              [
                page.repos,
                page.cursor && page.repos.length > 0 ? Option.some(page.cursor) : Option.none(),
              ] as const,
          ),
        ),
      ),
  };
};

/** Write namespace client over the native binding. */
export const makeWriteNamespaceClient = ({
  raw,
  openRepo,
}: ArtifactsHelpers): WriteNamespaceClient => ({
  raw,
  create: (name, opts) =>
    raw.pipe(
      Effect.flatMap((artifacts) =>
        tryArtifacts(() => artifacts.create(name, opts), CreateRepoErrorCodes),
      ),
    ),
  import: (params) =>
    raw.pipe(
      Effect.flatMap((artifacts) =>
        tryArtifacts(() => artifacts.import(params), ImportRepoErrorCodes),
      ),
    ),
  delete: (name) =>
    raw.pipe(
      Effect.flatMap((artifacts) =>
        tryArtifacts(() => artifacts.delete(name), DeleteRepoErrorCodes),
      ),
    ),
  get: (name) => openRepo(name).pipe(Effect.map((repo) => makeWriteRepoClient(name, repo))),
});
