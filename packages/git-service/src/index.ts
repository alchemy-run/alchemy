/**
 * @alchemy.run/git-service — a Git hosting service on Cloudflare Workers,
 * Durable Objects, and R2, built with Alchemy Effect-native Workers.
 *
 * Public surface:
 * - The REST contract ({@link GitApi}) with its schemas and tagged errors.
 * - Auth plumbing (credential parsing, token mint/hash helpers).
 * - The deployable pieces: {@link GitWorker}, the {@link GitRepo} /
 *   {@link Registry} Durable Objects, and the {@link GitService} construct
 *   function (yielded inside your own `Alchemy.Stack`).
 *
 * Internals (wire-protocol codecs under `git/`, storage under `store/`,
 * alarm jobs under `jobs/`) are deliberately not re-exported here — deep
 * import them via `@alchemy.run/git-service/git/Pkt.ts` style paths when
 * needed.
 */
export * from "./Api.ts";
export * from "./Auth.ts";
export { ADMIN_TOKEN_CONFIG_KEY, default as GitWorker } from "./GitWorker.ts";
export {
  GitObjectsBucket,
  GitRepo,
  GitRepoLive,
  MAX_PACK_BYTES,
} from "./RepoObject.ts";
export {
  Registry,
  RegistryLive,
  REGISTRY_DO_NAME,
  RESERVED_OWNERS,
} from "./RegistryObject.ts";
export { GitService, type GitServiceOptions } from "./Service.ts";
