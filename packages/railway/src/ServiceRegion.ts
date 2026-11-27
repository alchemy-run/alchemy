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
export class ServiceInvalidReplicas extends Data.TaggedError("Railway.ServiceInvalidReplicas")<{
  resourceName: string;
  replicas: number;
}> {
  override get message() {
    return `Railway service ${this.resourceName}: replicas must be a whole number of at least 1, not ${this.replicas}`;
  }
}

/** Whether `replicas` is a count Railway can run: a whole number of at least 1. */
export const isReplicaCount = (replicas: number) => Number.isSafeInteger(replicas) && replicas >= 1;

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

/**
 * Patch that leaves `desired` as the only region with replicas.
 * `undefined` when that is already true. With `replicas`, the region runs
 * exactly that many. Without it, an existing count on `desired` is kept;
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
  (args: { environmentId: string; commitMessage: string; patch: unknown; skipDeploys?: boolean }) =>
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

/** Region reported by the environment config, without writing. */
export const readServiceRegion = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  legacy?: string | null;
}) {
  if (input.environmentId.length === 0 || input.serviceId.length === 0) {
    return observedRegion({}, input.legacy);
  }
  const placement = yield* readPlacement(input);
  return observedRegion(placement, input.legacy);
});

const waitUntilRegion = (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  region: string;
  legacy?: string | null;
}) =>
  readServiceRegion(input).pipe(
    Effect.flatMap((observed) =>
      observed === input.region
        ? Effect.succeed(input.region)
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
      readServiceRegion(input).pipe(
        Effect.flatMap((observed) =>
          observed === input.region
            ? Effect.succeed(input.region)
            : Effect.fail(
                new ServiceRegionNotApplied({
                  serviceId: input.serviceId,
                  environmentId: input.environmentId,
                  region: input.region,
                  observed,
                }),
              ),
        ),
      ),
    ),
  );

/**
 * Make `region` the only replica placement, or read the current one when
 * `region` is omitted. With `replicas`, also run exactly that many there;
 * without `region`, they run in the service's current single region.
 * Replica moves go through `environmentPatchCommit`
 * (`services[id].deploy.multiRegionConfig`), the same patch Railway's CLI
 * applies for `railway scale`. Railway starts a deployment for every such
 * commit that replaces each replica; with `skipDeploys` the commit only
 * stages the placement for the caller's own next deploy. `patched` says
 * whether there was anything to commit.
 */
export const placeServiceRegion = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  region: string | undefined;
  legacy?: string | null;
  fallbackReplicas?: number | null;
  replicas?: number | undefined;
  skipDeploys?: boolean | undefined;
}) {
  if (input.region === undefined && input.replicas === undefined) {
    return { region: yield* readServiceRegion(input), patched: false };
  }
  const desired = input.region ?? (yield* readServiceRegion(input));
  // Nowhere to count replicas yet (a service never placed, or spread
  // over several regions): leave the placement as it is.
  if (desired === undefined) return { region: desired, patched: false };
  const patched = yield* withEnvironmentConfigLock(
    input.environmentId,
    Effect.gen(function* () {
      const placement = yield* readPlacement(input);
      const patch = regionPlacementPatch(
        desired,
        placement,
        input.fallbackReplicas ?? undefined,
        input.replicas,
      );
      if (patch === undefined) return false;
      yield* environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage:
          input.replicas === undefined
            ? `Pin Railway service region to ${desired}`
            : `Run ${input.replicas} Railway replica(s) in ${desired}`,
        patch: {
          services: {
            [input.serviceId]: {
              deploy: { multiRegionConfig: patch },
            },
          },
        },
        ...(input.skipDeploys === true ? { skipDeploys: true } : {}),
      });
      return true;
    }),
  );
  if (!patched) return { region: desired, patched };
  return { region: yield* waitUntilRegion({ ...input, region: desired }), patched };
});

/** {@link placeServiceRegion}, for the region it leaves the service in. */
export const syncServiceRegion = (input: Parameters<typeof placeServiceRegion>[0]) =>
  Effect.map(placeServiceRegion(input), ({ region }) => region);
