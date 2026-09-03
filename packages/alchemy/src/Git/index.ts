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
 * - Auth: {@link Authenticated} (the middleware contract), {@link Caller},
 *   {@link Policy}, and the shipped {@link AuthenticatedSecret} and
 *   {@link PolicyOwners}.
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
  Authenticated,
  AuthenticatedSecret,
  Caller,
  currentCaller,
  isReadAction,
  owns,
  parseBasic,
  parseBearer,
  parseSecret,
  Policy,
  PolicyOwners,
  PrincipalSchema,
  SECRET_RESOURCE_ID,
  timingSafeEqual,
  type GitAction,
  type Headers,
  type PolicyShape,
  type Principal,
  type RefUpdate,
  type RepoContext,
  type Resolve,
} from "./Auth.ts";
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
export { GitRepo, GitRepoLive, MAX_PACK_BYTES } from "./RepoObject.ts";
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
