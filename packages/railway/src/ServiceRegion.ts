import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

class ServiceRegionPending extends Data.TaggedError("Railway.ServiceRegionPending")<{
  serviceId: string;
  region: string;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

/** Replicas Railway is placing across every region. `undefined` when none. */
export const observedReplicas = (placement: RegionPlacement): number | undefined => {
  const active = activeReplicaRegions(placement);
  return active.length === 0 ? undefined : active.reduce((sum, row) => sum + row.replicas, 0);
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

/** `deploy.multiRegionConfig` for `serviceId` inside an environment config. */
export const serviceRegionPlacement = (config: unknown, serviceId: string): RegionPlacement => {
  if (!isRecord(config)) return {};
  const services = config.services;
  if (!isRecord(services)) return {};
  const service = services[serviceId];
  if (!isRecord(service)) return {};
  const deploy = service.deploy;
  if (!isRecord(deploy)) return {};
  const multiRegionConfig = deploy.multiRegionConfig;
  if (!isRecord(multiRegionConfig)) return {};

  const placement: RegionPlacement = {};
  for (const [region, value] of Object.entries(multiRegionConfig)) {
    if (value === null) {
      placement[region] = null;
      continue;
    }
    if (!isRecord(value)) continue;
    const replicas = value.numReplicas;
    placement[region] = typeof replicas === "number" ? { numReplicas: replicas } : {};
  }
  return placement;
};

const readEnvironmentConfig = Query.fn((args: { id: string; projectId?: string }) => ({
  config: Railway.environment(args).config,
}));

const environmentPatchCommit = Query.fn(
  (args: { environmentId: string; commitMessage: string; patch: unknown }) =>
    Railway.environmentPatchCommit(args),
);

const readPlacement = (input: { environmentId: string; projectId: string; serviceId: string }) =>
  readEnvironmentConfig(
    input.projectId.length > 0
      ? { id: input.environmentId, projectId: input.projectId }
      : { id: input.environmentId },
  ).pipe(
    Effect.map((environment) => serviceRegionPlacement(environment.config, input.serviceId)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed({} as RegionPlacement)),
  );

/** Region and replica count reported by the environment config, without writing. */
export const readServicePlacement = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  legacy?: string | null;
}) {
  if (input.environmentId.length === 0 || input.serviceId.length === 0) {
    return { region: observedRegion({}, input.legacy), replicas: undefined };
  }
  const placement = yield* readPlacement(input);
  return { region: observedRegion(placement, input.legacy), replicas: observedReplicas(placement) };
});

/** Region reported by the environment config, without writing. */
export const readServiceRegion = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  legacy?: string | null;
}) {
  return (yield* readServicePlacement(input)).region;
});

const waitUntilPlaced = (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  region: string;
  replicas: number | undefined;
  legacy?: string | null;
}) => {
  const placed = (observed: { region: string | undefined; replicas: number | undefined }) =>
    observed.region === input.region &&
    (input.replicas === undefined || observed.replicas === input.replicas);
  return readServicePlacement(input).pipe(
    Effect.flatMap((observed) =>
      placed(observed)
        ? Effect.succeed(observed)
        : Effect.fail(
            new ServiceRegionPending({
              serviceId: input.serviceId,
              region: input.region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Railway.ServiceRegionPending",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("Railway.ServiceRegionPending", () =>
      Effect.gen(function* () {
        const observed = yield* readServicePlacement(input);
        if (placed(observed)) return observed;
        if (observed.region !== input.region || input.replicas === undefined) {
          return yield* new ServiceRegionNotApplied({
            serviceId: input.serviceId,
            environmentId: input.environmentId,
            region: input.region,
            observed: observed.region,
          });
        }
        return yield* new ServiceReplicasNotApplied({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          replicas: input.replicas,
          observed: observed.replicas,
        });
      }),
    ),
  );
};

export type PlacementTarget =
  | { readonly _tag: "region"; readonly region: string }
  | { readonly _tag: "defer" }
  | { readonly _tag: "unknown"; readonly regions: ReadonlyArray<string> };

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
  if (region !== undefined) return { _tag: "region", region };
  const regions = activeReplicaRegions(input.placement).map((row) => row.region);
  if (regions.length === 0 && input.deferIfUnknown === true) return { _tag: "defer" };
  return { _tag: "unknown", regions };
};

/** `replicas` as given, or a typed failure when Railway would not place it. */
export const validateReplicas = (serviceId: string, replicas: number | undefined) =>
  replicas !== undefined && !(Number.isInteger(replicas) && replicas >= 1)
    ? Effect.fail(new ServiceReplicasInvalid({ serviceId, replicas }))
    : Effect.succeed(replicas);

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
      const target = placementTarget({
        region: input.region,
        placement,
        legacy: input.legacy,
        deferIfUnknown: input.deferIfUnknown,
      });
      if (target._tag === "defer") {
        return {
          changed: false as const,
          region: undefined,
          replicas: observedReplicas(placement),
        };
      }
      if (target._tag === "unknown") {
        // `replicas` is set here: no `region` and no single region to scale.
        return yield* new ServiceReplicasRegionUnknown({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          regions: target.regions,
        });
      }
      const desired = target.region;
      const patch = regionPlacementPatch(
        desired,
        placement,
        input.fallbackReplicas ?? undefined,
        replicas,
      );
      if (patch === undefined) {
        return { changed: false as const, region: desired, replicas: observedReplicas(placement) };
      }
      yield* environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage:
          input.region === undefined
            ? `Scale Railway service to ${replicas} replicas`
            : `Pin Railway service region to ${desired}`,
        patch: {
          services: {
            [input.serviceId]: {
              deploy: { multiRegionConfig: patch },
            },
          },
        },
      });
      return { changed: true as const, region: desired, replicas: undefined };
    }),
  );
  if (!patched.changed) return { region: patched.region, replicas: patched.replicas };
  return yield* waitUntilPlaced({ ...input, region: patched.region, replicas });
});

/**
 * Make `region` the only replica placement, or read the current one when
 * `region` is omitted.
 */
export const syncServiceRegion = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  region: string | undefined;
  legacy?: string | null;
  fallbackReplicas?: number | null;
}) {
  return (yield* syncServicePlacement(input)).region;
});
