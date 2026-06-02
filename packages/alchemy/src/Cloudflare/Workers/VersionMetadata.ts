type VersionMetadataTypeId = typeof VersionMetadataTypeId;
const VersionMetadataTypeId = "Cloudflare.VersionMetadata" as const;

/**
 * Marker for a Cloudflare Workers Version Metadata binding.
 *
 * Version Metadata is declared directly on a Worker's `env` and Cloudflare
 * provides the deployed Worker version at runtime (`id`, `tag`, `timestamp`).
 *
 * @binding
 *
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     CF_VERSION_METADATA: Cloudflare.VersionMetadata(),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { CF_VERSION_METADATA: WorkerVersionMetadata }
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
 */
export interface VersionMetadata {
  kind: VersionMetadataTypeId;
}

export const isVersionMetadata = (value: unknown): value is VersionMetadata =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as VersionMetadata).kind === VersionMetadataTypeId;

export const VersionMetadata = (): VersionMetadata => ({
  kind: VersionMetadataTypeId,
});
