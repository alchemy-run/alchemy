import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import { toFqn } from "../FQN.ts";
import type { Input, InputProps } from "../Input.ts";
import { CurrentNamespace } from "../Namespace.ts";
import type {
  ResourceClass,
  ResourceConstructor,
  ResourceLike,
} from "../Resource.ts";
import { Stack } from "../Stack.ts";
import type { Fleet } from "./Fleet.ts";
import type { FleetBucket } from "./Host.ts";

/** Deployment-only fleet selection, supplied by `Fleet.layer(Cells)`. */
export class CurrentFleet extends Context.Service<CurrentFleet, Fleet>()(
  "Celld.CurrentFleet",
) {}

/** Connection material captured at declaration time, never selected globally. */
export interface FleetResourceProps {
  /** Captured fleet FQN. @internal */
  fleetId?: string;
  /** Captured fleet endpoint. @internal */
  fleetUrl?: string;
  /** Captured backing bucket. @internal */
  bucket?: FleetBucket;
  /** Captured host connection state. @internal */
  hostState?: Record<string, any>;
}

/** Persisted connection material for a retained identity. */
export interface FleetResourceAttributes {
  /** Owning Fleet's fully qualified name. */
  fleetId: string;
  /** Fleet endpoint used for deployment-time binding validation. */
  fleetUrl: string;
  /** Backing bucket retained with the identity. @internal */
  bucket: FleetBucket;
  /** Host-specific storage connection material. @internal */
  hostState: Record<string, any> | undefined;
}

/** A logical registration cannot select two different fleets. */
export class FleetRegistrationConflict extends Data.TaggedError(
  "Celld.FleetRegistrationConflict",
)<{
  readonly message: string;
  readonly fqn: string;
  readonly fleetId: string;
  readonly existingFleetId: string | undefined;
}> {}

/** Capture fleet selection before Resource's idempotent-registration shortcut. */
export const withFleet = <R extends ResourceLike<string, FleetResourceProps>>(
  resource: ResourceClass<R>,
): ResourceClass<R> => {
  const register = resource as (
    id: string,
    props?: Input<R["Props"]>,
  ) => Effect.Effect<R, never, R["Providers"]>;
  const constructor = (
    id: string,
    props?: InputProps<R["Props"]> | Effect.Effect<InputProps<R["Props"]>>,
  ) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return yield* register(id);
      }
      const fleet = yield* CurrentFleet;
      const stack = yield* Stack;
      const fqn = toFqn(yield* CurrentNamespace, id);
      const existing = stack.resources[fqn];
      if (
        existing &&
        (existing.Type !== resource.Type ||
          existing.Props?.fleetId !== fleet.FQN)
      ) {
        return yield* Effect.die(
          new FleetRegistrationConflict({
            message: `Resource '${fqn}' is already registered in fleet '${existing.Props?.fleetId ?? "unknown"}', not '${fleet.FQN}'. Use distinct namespaces for distinct fleets.`,
            fqn,
            fleetId: fleet.FQN,
            existingFleetId: existing.Props?.fleetId,
          }),
        );
      }
      const resolved = Effect.isEffect(props) ? yield* props : props;
      return yield* register(id, {
        ...resolved,
        fleetId: fleet.FQN,
        fleetUrl: fleet.fleetUrl,
        bucket: fleet.bucket,
        hostState: fleet.hostState,
      } as unknown as Input<R["Props"]>);
    });
  function wrapped(
    id: string | object,
    props?: InputProps<R["Props"]> | Effect.Effect<InputProps<R["Props"]>>,
  ):
    | Effect.Effect<R, never, CurrentFleet | Stack | R["Providers"]>
    | ResourceClass<R> {
    return typeof id === "object"
      ? (Object.assign(wrapped, id) as ResourceClass<R>)
      : constructor(id, props);
  }
  return Object.assign(
    wrapped,
    {
      Type: resource.Type,
      Props: resource.Props,
      Provider: resource.Provider,
      Self: resource.Self,
      Aliases: resource.Aliases,
      ref: resource.ref,
    },
    Effectable.Prototype({
      label: `FleetResource<${resource.Type}>`,
      evaluate: () => Effect.succeed(constructor as ResourceConstructor<R>),
    }),
  ) as ResourceClass<R>;
};
