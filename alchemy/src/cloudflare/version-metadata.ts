/**
 * Type representing a version metadata binding.
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
 */
export type VersionMetadata = {
  type: "version_metadata";
};

/**
 * Creates a version metadata binding that provides access to version information at runtime.
 *
 * @example
 * ```ts
 * const metadata = VersionMetadata();
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
 */
export function VersionMetadata(): VersionMetadata {
  return {
    type: "version_metadata",
  };
}
