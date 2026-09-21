import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** Exact runtime release supported by the native deployment protocol. */
export const DEFAULT_CELLD_VERSION = "0.5.0";

/** Multi-architecture v0.5.0 image, release commit 12d5b6333fe52717325addcfe1e99e9fd4f77bcd. */
export const DEFAULT_CELLD_IMAGE =
  "ghcr.io/denoland/celld@sha256:df8e74bb9a059df5779644368984933eba76acd6a2d196672732f4368f760fc8";

/** Public Worker traffic; the peer/operator listener must remain private. */
export const CELLD_PUBLIC_PORT = 8080;
/** Private peer and operator listener. */
export const CELLD_INTERNAL_PORT = 8081;
/** Native startup recovery and graceful-drain readiness. */
export const CELLD_HEALTH_PATH = "/.well-known/celld/health";

/** The requested image or deployment protocol uses an unsupported release. */
export class CelldVersionMismatch extends Data.TaggedError(
  "Celld.VersionMismatch",
)<{
  readonly message: string;
}> {}

/** Binary upgrades require explicit maintenance, never a Worker redeployment. */
export const validateCelldVersion = (version: string) =>
  version === DEFAULT_CELLD_VERSION
    ? Effect.void
    : Effect.fail(
        new CelldVersionMismatch({
          message: `Celld ${version} is not supported by this adapter; use ${DEFAULT_CELLD_VERSION}. Binary upgrades require an explicit stopped-fleet upgrade procedure.`,
        }),
      );
