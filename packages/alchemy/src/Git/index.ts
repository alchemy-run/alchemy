/**
 * alchemy/Git — a Git hosting service on Cloudflare Workers,
 * Durable Objects, and R2, built with Alchemy Effect-native Workers.
 *
 * Public surface:
 * - The HTTP contract ({@link GitApi}, aliased {@link Api}): every plane as
 *   one `HttpApi`, each endpoint an `alchemy/Http` route class, each group a
 *   class, with the schemas and tagged errors.
 * - {@link Handlers}, the default implementation of every route, and the
 *   per-route `*Live` Layers it is made of.
 * - {@link Hooks}, git's pre-receive hook as a service. There is no auth
 *   in the engine: the middleware of the API that mounts the routes decides
 *   who gets in.
 * - The deployable pieces: {@link Server} + {@link ServerLive}, the
 *   {@link GitRepo} / {@link Registry} Durable Objects, and the storage and
 *   hasher blocks.
 *
 * Internals (wire-protocol codecs under `Protocol/`, storage under `Store/`,
 * alarm jobs under `Jobs/`) are deliberately not re-exported here — deep
 * import them via `alchemy/Git/Protocol/Pkt.ts` style paths when
 * needed.
 */
export * from "./Api.ts";
export { GitApi as Api } from "./Api.ts";
export {
  Hooks,
  HooksNone,
  type HooksShape,
  type RefRejection,
  type RefUpdate,
} from "./Hooks.ts";
export * from "./Server.ts";
export {
  BlobStore,
  BlobStoreR2,
  BlobStoreError,
  type BlobBody,
  type BlobMeta,
  type BlobMultipart,
  type BlobStoreShape,
} from "./BlobStore.ts";
export { BlobStoreS3, type BlobStoreS3Options } from "./BlobStoreS3.ts";
export { RegistryD1 } from "./RegistryD1.ts";
export {
  GitRepo,
  GitRepoLive,
  MAX_PACK_BYTES,
  type CommitPushInput,
  type CommitPushResult,
  type GitRepoShape,
  type RepoMetaData,
  RepoStore,
  type RepoStoreShape,
  type RepoStub,
} from "./RepoObject.ts";
export {
  Registry,
  RegistryDurableObject,
  RegistryLive,
  RegistryStore,
  REGISTRY_DO_NAME,
  RESERVED_OWNERS,
} from "./RegistryObject.ts";

export {
  Hasher,
  HasherInline,
  HasherSelf,
  HASHER_BINDING,
} from "./Hasher/Hasher.ts";
