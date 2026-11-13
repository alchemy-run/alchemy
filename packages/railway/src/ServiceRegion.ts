import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { environmentPatchCommit, readEnvironmentConfig } from "./GraphQL.ts";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * `deploy.multiRegionConfig` on one service. `null` removes a region.
 * Railway ignores `ServiceInstance.region`; this map is the placement.
 */
export type RegionPlacement = Record<string, { readonly numReplicas?: number | null } | null>;

export class ServiceRegionNotApplied extends Data.TaggedError("Railway.ServiceRegionNotApplied")<{
  serviceId: string;
  environmentId: string;
  region: string;
  observed: string | undefined;
}> {
  override get message() {
    const where = this.observed ?? "no region";
    return `Railway service ${this.serviceId} is in ${where} after requesting ${this.region}`;
  }
}

/** `replicas` is not a whole number of at least 1. */
export class ServiceReplicasInvalid extends Data.TaggedError("Railway.ServiceReplicasInvalid")<{
  serviceId: string;
  replicas: number;
}> {
  override get message() {
    return `Railway service ${this.serviceId} needs at least 1 replica as a whole number, got ${this.replicas}`;
  }
}

/**
 * `replicas` was set without `region` and the service has no single region
 * to put them in: replicas span several regions, or none is known yet.
 */
export class ServiceReplicasRegionUnknown extends Data.TaggedError(
  "Railway.ServiceReplicasRegionUnknown",
)<{
  serviceId: string;
  environmentId: string;
  regions: ReadonlyArray<string>;
}> {
  override get message() {
    const where =
      this.regions.length > 0
        ? `replicas in ${this.regions.join(", ")}`
        : "no region reported by Railway";
    return `Railway service ${this.serviceId} has ${where}; set \`region\` alongside \`replicas\``;
  }
}

export class ServiceReplicasNotApplied extends Data.TaggedError(
  "Railway.ServiceReplicasNotApplied",
)<{
  serviceId: string;
  environmentId: string;
  replicas: number;
  observed: number | undefined;
}> {
  override get message() {
    const where = this.observed ?? "no";
    return `Railway service ${this.serviceId} has ${where} replicas after requesting ${this.replicas}`;
  }
}

/** Replicas Railway is actually placing. Empty objects and nulls are absent. */
export const activeReplicaRegions = (
  placement: RegionPlacement,
): Array<{ region: string; replicas: number }> => {
  const active: Array<{ region: string; replicas: number }> = [];
  for (const [region, value] of Object.entries(placement)) {
    const replicas = value?.numReplicas;
    if (typeof replicas === "number" && replicas >= 1) {
      active.push({ region, replicas });
    }
  }
  return active;
};

/**
 * The service's region when exactly one region has replicas. Several
 * regions means there is no single region. An empty map falls back to
 * the legacy `ServiceInstance.region` field.
 */
export const observedRegion = (
  placement: RegionPlacement,
  legacy: string | null | undefined,
): string | undefined => {
  const active = activeReplicaRegions(placement);
  const only = active[0];
  if (active.length === 1 && only !== undefined) return only.region;
  if (active.length > 1) return undefined;
  return legacy != null && legacy.length > 0 ? legacy : undefined;
};

/** Replicas Railway is placing across every region. `None` when none. */
export const observedReplicas = (placement: RegionPlacement): Option.Option<number> => {
  const active = activeReplicaRegions(placement);
  return active.length === 0
    ? Option.none()
    : Option.some(active.reduce((sum, row) => sum + row.replicas, 0));
};

/**
 * Patch that leaves `desired` as the only region with replicas.
 * `undefined` when that is already true. `replicas` sets the count on
 * `desired`. Without it an existing count on `desired` is kept;
 * otherwise the current replicas move with the service.
 */
export const regionPlacementPatch = (
  desired: string,
  placement: RegionPlacement,
  fallbackReplicas?: number,
  replicas?: number,
): Record<string, { numReplicas: number } | null> | undefined => {
  const active = activeReplicaRegions(placement);
  const only = active[0];
  if (
    active.length === 1 &&
    only !== undefined &&
    only.region === desired &&
    (replicas === undefined || only.replicas === replicas)
  ) {
    return undefined;
  }

  const current = active.find((row) => row.region === desired)?.replicas;
  const moved = active.reduce((sum, row) => sum + row.replicas, 0);
  const fallback =
    typeof fallbackReplicas === "number" && fallbackReplicas >= 1 ? fallbackReplicas : 1;
  const numReplicas = replicas ?? current ?? (moved > 0 ? moved : fallback);
  const patch: Record<string, { numReplicas: number } | null> = {
    [desired]: { numReplicas },
  };
  for (const region of Object.keys(placement)) {
    if (region !== desired) patch[region] = null;
  }
  return patch;
};

/** The slice of an environment config that holds `deploy.multiRegionConfig`. */
const PlacementConfig = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({
      deploy: Schema.Struct({
        multiRegionConfig: Schema.Record(
          Schema.String,
          Schema.Struct({
            numReplicas: Schema.Number.pipe(Schema.NullOr, Schema.optional),
          }).pipe(Schema.NullOr),
        ).pipe(Schema.NullOr, Schema.optional),
      }).pipe(Schema.NullOr, Schema.optional),
    }).pipe(Schema.NullOr),
  ).pipe(Schema.NullOr, Schema.optional),
});

/**
 * `deploy.multiRegionConfig` for `serviceId` inside an environment config.
 * Empty when Railway has none. Fails with a `SchemaError` when the config
 * does not have the expected shape.
 */
export const serviceRegionPlacement = (config: unknown, serviceId: string) =>
  Schema.decodeUnknownEffect(PlacementConfig)(config).pipe(
    Effect.map(
      (decoded): RegionPlacement => decoded.services?.[serviceId]?.deploy?.multiRegionConfig ?? {},
    ),
  );

const readPlacement = (input: { environmentId: string; projectId: string; serviceId: string }) =>
  readEnvironmentConfig(
    input.projectId.length > 0
      ? { id: input.environmentId, projectId: input.projectId }
      : { id: input.environmentId },
  ).pipe(
    Effect.flatMap((environment) => serviceRegionPlacement(environment.config, input.serviceId)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed<RegionPlacement>({})),
  );

/** Region and replica count Railway reports for one service. */
export interface ObservedPlacement {
  readonly region: Option.Option<string>;
  readonly replicas: Option.Option<number>;
}

const toObserved = (placement: RegionPlacement, legacy?: string | null): ObservedPlacement => ({
  region: Option.fromNullishOr(observedRegion(placement, legacy)),
  replicas: observedReplicas(placement),
});

/** Region and replica count reported by the environment config, without writing. */
export const readServicePlacement = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  legacy?: string | null;
}) {
  const placement =
    input.environmentId.length === 0 || input.serviceId.length === 0
      ? {}
      : yield* readPlacement(input);
  return toObserved(placement, input.legacy);
});

const waitUntilPlaced = (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  region: string;
  replicas: number | undefined;
  legacy?: string | null;
}) => {
  const inRegion = (observed: ObservedPlacement) => Option.contains(observed.region, input.region);
  const placed = (observed: ObservedPlacement) =>
    inRegion(observed) &&
    (input.replicas === undefined || Option.contains(observed.replicas, input.replicas));
  return readServicePlacement(input).pipe(
    Effect.repeat({ until: placed, schedule: Schedule.spaced("1 second"), times: 10 }),
    Effect.flatMap((observed) =>
      Effect.gen(function* () {
        if (placed(observed)) return observed;
        if (!inRegion(observed) || input.replicas === undefined) {
          return yield* new ServiceRegionNotApplied({
            serviceId: input.serviceId,
            environmentId: input.environmentId,
            region: input.region,
            observed: Option.getOrUndefined(observed.region),
          });
        }
        return yield* new ServiceReplicasNotApplied({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          replicas: input.replicas,
          observed: Option.getOrUndefined(observed.replicas),
        });
      }),
    ),
  );
};

export type PlacementTarget = Data.TaggedEnum<{
  /** Write the placement to this region. */
  Region: { readonly region: string };
  /** No region is known yet; apply after the first deploy. */
  Defer: {};
  /** No single region to scale: replicas span `regions`, or there are none. */
  Unknown: { readonly regions: ReadonlyArray<string> };
}>;

export const PlacementTarget = Data.taggedEnum<PlacementTarget>();

/**
 * Region a placement write goes to: `region` when set, else the single
 * region the service is in. A service with no region yet (a fresh create,
 * before its first deploy) is `defer` when `deferIfUnknown` is set, so the
 * call after the deploy applies it. Replicas spread over several regions
 * are always `unknown`.
 */
export const placementTarget = (input: {
  region: string | undefined;
  placement: RegionPlacement;
  legacy?: string | null;
  deferIfUnknown?: boolean;
}): PlacementTarget => {
  const region = input.region ?? observedRegion(input.placement, input.legacy);
  if (region !== undefined) return PlacementTarget.Region({ region });
  const regions = activeReplicaRegions(input.placement).map((row) => row.region);
  if (regions.length === 0 && input.deferIfUnknown === true) return PlacementTarget.Defer();
  return PlacementTarget.Unknown({ regions });
};

/** A replica count Railway will place: a whole number of at least 1. */
const Replicas = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** `replicas` as given, or a typed failure when Railway would not place it. */
export const validateReplicas = (serviceId: string, replicas: number | undefined) =>
  replicas === undefined || Schema.is(Replicas)(replicas)
    ? Effect.succeed(replicas)
    : Effect.fail(new ServiceReplicasInvalid({ serviceId, replicas }));

/**
 * Make `region` the only replica placement (with `replicas` of them when
 * set), or read the current placement when both are omitted. `replicas`
 * without `region` scales the one region the service is already in. Moves
 * go through `environmentPatchCommit` (`services[id].deploy.multiRegionConfig`),
 * the same patch Railway's CLI applies for `railway scale`.
 */
export const syncServicePlacement = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  region: string | undefined;
  replicas?: number | undefined;
  legacy?: string | null;
  fallbackReplicas?: number | null;
  /**
   * Skip, rather than fail, when `replicas` is set without `region` and
   * Railway reports no region yet. For the call before a first deploy.
   */
  deferIfUnknown?: boolean;
}) {
  const replicas = yield* validateReplicas(input.serviceId, input.replicas);
  if (input.region === undefined && replicas === undefined) {
    return yield* readServicePlacement(input);
  }
  const patched = yield* withEnvironmentConfigLock(
    input.environmentId,
    Effect.gen(function* () {
      const placement = yield* readPlacement(input);
      const unchanged = (region: Option.Option<string>) =>
        Effect.succeed({
          changed: false as const,
          observed: { region, replicas: observedReplicas(placement) },
        });
      const target = placementTarget({
        region: input.region,
        placement,
        legacy: input.legacy,
        deferIfUnknown: input.deferIfUnknown,
      });
      return yield* PlacementTarget.$match(target, {
        Defer: () => unchanged(Option.none()),
        // `replicas` is set here: no `region` and no single region to scale.
        Unknown: ({ regions }) =>
          Effect.fail(
            new ServiceReplicasRegionUnknown({
              serviceId: input.serviceId,
              environmentId: input.environmentId,
              regions,
            }),
          ),
        Region: ({ region }) => {
          const patch = regionPlacementPatch(
            region,
            placement,
            input.fallbackReplicas ?? undefined,
            replicas,
          );
          if (patch === undefined) return unchanged(Option.some(region));
          return environmentPatchCommit({
            environmentId: input.environmentId,
            commitMessage:
              input.region === undefined
                ? `Scale Railway service to ${replicas} replicas`
                : `Pin Railway service region to ${region}`,
            patch: {
              services: {
                [input.serviceId]: {
                  deploy: { multiRegionConfig: patch },
                },
              },
            },
          }).pipe(Effect.as({ changed: true as const, region }));
        },
      });
    }),
  );
  if (!patched.changed) return patched.observed;
  return yield* waitUntilPlaced({ ...input, region: patched.region, replicas });
});
