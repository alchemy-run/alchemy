import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * The release series whose deployment protocol and bucket format this
 * integration speaks. Releases within a series upgrade with a rolling
 * restart of the fleet's nodes.
 */
export const CELLD_RUNTIME_SERIES = "0.6";

/** The runtime release new fleets run. */
export const DEFAULT_CELLD_VERSION = "0.6.3";

/** Multi-architecture v0.6.3 image, release commit 8702f6d186c77698dbfb30cf29e3b1922a88f008. */
export const DEFAULT_CELLD_IMAGE =
  "ghcr.io/denoland/celld@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc";

/** Whether a runtime release belongs to the supported series. */
export const isSupportedCelldVersion = (version: string) =>
  version === CELLD_RUNTIME_SERIES || version.startsWith(`${CELLD_RUNTIME_SERIES}.`);

/** Public Worker traffic; the peer/operator listener must remain private. */
export const CELLD_PUBLIC_PORT = 8080;
/** Private peer and operator listener. */
export const CELLD_INTERNAL_PORT = 8081;
/** Native startup recovery and graceful-drain readiness. */
export const CELLD_HEALTH_PATH = "/.well-known/celld/health";

/** The requested image or deployment protocol uses an unsupported release. */
export class CelldVersionMismatch extends Data.TaggedError("Celld.VersionMismatch")<{
  readonly message: string;
}> {}

/** Refuse a runtime release outside the supported series. */
export const validateCelldVersion = (version: string) =>
  isSupportedCelldVersion(version)
    ? Effect.void
    : Effect.fail(
        new CelldVersionMismatch({
          message: `Celld ${version} is not supported by this integration; use a ${CELLD_RUNTIME_SERIES}.x release (default ${DEFAULT_CELLD_VERSION}).`,
        }),
      );
