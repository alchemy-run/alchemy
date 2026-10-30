import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { requireHost } from "./Fleet.ts";
import type { FleetConnection } from "./Host.ts";

/** A conditional object-store operation failed. */
export class FleetStorageError extends Data.TaggedError("Celld.FleetStorageError")<{
  readonly reason: "conflict" | "not-found" | "transport" | "configuration";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly etag: string;
}

export interface Store {
  readonly get: (key: string) => Effect.Effect<StoredObject | undefined, FleetStorageError>;
  readonly put: (
    key: string,
    body: Uint8Array,
    condition?: { readonly ifMatch?: string; readonly ifNoneMatch?: boolean },
  ) => Effect.Effect<{ readonly etag: string }, FleetStorageError>;
  readonly delete: (
    key: string,
    condition?: { readonly ifMatch?: string },
  ) => Effect.Effect<void, FleetStorageError>;
  readonly list: (
    prefix: string,
  ) => Effect.Effect<readonly { readonly key: string; readonly etag: string }[], FleetStorageError>;
}

/** Deployment-only access to a fleet's backing object store. */
export class FleetStorage extends Context.Service<
  FleetStorage,
  (connection: FleetConnection) => Effect.Effect<Store, FleetStorageError>
>()("Celld.FleetStorage") {}

/** Open a fleet's store through the provided {@link Host}. */
export const FleetStorageFromHost = Layer.succeed(FleetStorage, (connection) =>
  requireHost("storage").pipe(
    Effect.mapError(
      (cause) => new FleetStorageError({ reason: "configuration", message: cause.message, cause }),
    ),
    Effect.flatMap((host) => host.storage(connection)),
  ),
);
