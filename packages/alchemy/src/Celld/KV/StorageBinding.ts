import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import type { Output } from "../../Output.ts";
import { CurrentFleet } from "../FleetContext.ts";

/** Fleet identity carried beside native bindings for deploy-time validation. */
export interface StorageBinding {
  /** Fully qualified declaration name for diagnostics. */
  resource: string;
  /** Fully qualified fleet resource name. */
  fleetId: string;
  /** Resolved fleet endpoint, including references to other stacks. */
  fleetUrl: string;
}

/** A native storage binding cannot reach a different fleet. */
export class StorageFleetMismatch extends Data.TaggedError(
  "Celld.StorageFleetMismatch",
)<{
  message: string;
  resource: string;
  workerFleet: string | undefined;
  resourceFleet: string;
}> {}

/** Validate resolved binding metadata before rendering a worker deployment. */
export const validateStorageBindings = (
  worker: { fleetId?: string; fleetUrl?: string },
  bindings: readonly StorageBinding[],
) =>
  Effect.forEach(
    bindings,
    (binding) =>
      worker.fleetId === binding.fleetId && worker.fleetUrl === binding.fleetUrl
        ? Effect.void
        : Effect.fail(
            new StorageFleetMismatch({
              message: `Storage declaration '${binding.resource}' belongs to fleet '${binding.fleetId}', not the worker's fleet '${worker.fleetId ?? "unknown"}'.`,
              resource: binding.resource,
              workerFleet: worker.fleetId,
              resourceFleet: binding.fleetId,
            }),
          ),
    { discard: true },
  );

export const storageBinding = (resource: {
  FQN: string;
  fleetId: Output<string>;
  fleetUrl: Output<string>;
}): Input<StorageBinding> => ({
  resource: resource.FQN,
  fleetId: resource.fleetId,
  fleetUrl: resource.fleetUrl,
});

/** Resolve the selected fleet only during infrastructure evaluation. */
export const storageFleetProps = () =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return {};
    }
    const fleet = yield* CurrentFleet;
    return {
      fleetId: fleet.FQN,
      fleetUrl: fleet.fleetUrl,
      bucket: fleet.bucket,
      hostState: fleet.hostState,
    };
  });
