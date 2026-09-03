/**
 * alchemy/Git — a Git hosting service on Cloudflare Workers,
 * Durable Objects, and R2, built with Alchemy Effect-native Workers.
 *
 * Public surface:
 * - The REST contract ({@link GitApi}) with its schemas and tagged errors.
 * - Auth plumbing (credential parsing, token mint/hash helpers).
 * - The deployable pieces: {@link Server} + {@link ServerLive}, the {@link GitRepo} /
 *   {@link Registry} Durable Objects, and the building-block layers
 *   function (yielded inside your own `Alchemy.Stack`).
 *
 * Internals (wire-protocol codecs under `Protocol/`, storage under `Store/`,
 * alarm jobs under `Jobs/`) are deliberately not re-exported here — deep
 * import them via `alchemy/Git/Protocol/Pkt.ts` style paths when
 * needed.
 */
export * from "./Api.ts";
export { GitApi as Api } from "./Api.ts";
export {
  Authenticate,
  AuthenticateSecret,
  Authenticated,
  AuthenticatedLive,
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
  SECRET_CONFIG_KEY,
  timingSafeEqual,
  type GitAction,
  type Headers,
  type PolicyShape,
  type Principal,
  type RefUpdate,
  type RepoContext,
} from "./Auth.ts";
export {
  GIT_WORKER_OPTIONS,
  GitHubApi,
  handlers,
  RawApi,
  ReposDurableObject,
  Server,
  ServerLive,
  ProtocolApi,
  type GitGroupName,
} from "./Server.ts";
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
