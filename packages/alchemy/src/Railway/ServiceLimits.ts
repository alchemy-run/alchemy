import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { environmentPatchCommit, readEnvironmentConfig } from "./ServiceRegion.ts";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * Per-replica resource limits, stored as
 * `services[id].deploy.limitOverride.containers` in the environment config.
 */
export interface ServiceLimits {
  /** vCPUs per replica. */
  readonly cpu?: number;
  /** Memory per replica in bytes. */
  readonly memoryBytes?: number;
}

export class ServiceLimitsNotApplied extends Data.TaggedError("Railway.ServiceLimitsNotApplied")<{
  serviceId: string;
  environmentId: string;
  limits: ServiceLimits;
  observed: ServiceLimits | undefined;
}> {
  override get message() {
    return `Railway service ${this.serviceId} limits are ${JSON.stringify(this.observed ?? {})} after requesting ${JSON.stringify(this.limits)}`;
  }
}

class ServiceLimitsPending extends Data.TaggedError("Railway.ServiceLimitsPending")<{
  serviceId: string;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `deploy.limitOverride.containers` for `serviceId`, or `undefined` when unset. */
export const serviceLimits = (config: unknown, serviceId: string): ServiceLimits | undefined => {
  if (!isRecord(config) || !isRecord(config.services)) return undefined;
  const service = config.services[serviceId];
  if (!isRecord(service) || !isRecord(service.deploy)) return undefined;
  const limitOverride = service.deploy.limitOverride;
  if (!isRecord(limitOverride) || !isRecord(limitOverride.containers)) return undefined;
  const { cpu, memoryBytes } = limitOverride.containers;
  const limits = {
    ...(typeof cpu === "number" ? { cpu } : {}),
    ...(typeof memoryBytes === "number" ? { memoryBytes } : {}),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
};

/**
 * `limitOverride` patch for the fields of `desired` that differ from
 * `observed`, or `undefined` when they all match. Omitted fields keep
 * their current value.
 */
export const limitsPatch = (
  desired: ServiceLimits,
  observed: ServiceLimits | undefined,
): { containers: ServiceLimits } | undefined => {
  const containers = {
    ...(desired.cpu !== undefined && desired.cpu !== observed?.cpu ? { cpu: desired.cpu } : {}),
    ...(desired.memoryBytes !== undefined && desired.memoryBytes !== observed?.memoryBytes
      ? { memoryBytes: desired.memoryBytes }
      : {}),
  };
  return Object.keys(containers).length > 0 ? { containers } : undefined;
};

/** Limits reported by the environment config, without writing. */
export const readServiceLimits = (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
}) =>
  input.environmentId.length === 0 || input.serviceId.length === 0
    ? Effect.succeed(undefined)
    : readEnvironmentConfig(
        input.projectId.length > 0
          ? { id: input.environmentId, projectId: input.projectId }
          : { id: input.environmentId },
      ).pipe(
        Effect.map((environment) => serviceLimits(environment.config, input.serviceId)),
        Effect.catchTag("RailwayNotFound", () => Effect.succeed(undefined)),
      );

const waitUntilLimits = (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  limits: ServiceLimits;
}) =>
  readServiceLimits(input).pipe(
    Effect.flatMap((observed) =>
      limitsPatch(input.limits, observed) === undefined
        ? Effect.succeed(observed)
        : Effect.fail(new ServiceLimitsPending({ serviceId: input.serviceId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "Railway.ServiceLimitsPending",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("Railway.ServiceLimitsPending", () =>
      readServiceLimits(input).pipe(
        Effect.flatMap((observed) =>
          Effect.fail(
            new ServiceLimitsNotApplied({
              serviceId: input.serviceId,
              environmentId: input.environmentId,
              limits: input.limits,
              observed,
            }),
          ),
        ),
      ),
    ),
  );

/**
 * Converge `deploy.limitOverride` on `limits`, or read the current limits
 * when `limits` is omitted. The patch commit redeploys the service, as the
 * dashboard's resource limits setting does.
 */
export const syncServiceLimits = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  limits: ServiceLimits | undefined;
}) {
  const desired = input.limits;
  if (desired === undefined) return yield* readServiceLimits(input);
  const observed = yield* withEnvironmentConfigLock(
    input.environmentId,
    Effect.gen(function* () {
      const current = yield* readServiceLimits(input);
      const patch = limitsPatch(desired, current);
      if (patch === undefined) return current;
      yield* environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage: "Set Railway service resource limits",
        patch: { services: { [input.serviceId]: { deploy: { limitOverride: patch } } } },
      });
      return undefined;
    }),
  );
  return observed ?? (yield* waitUntilLimits({ ...input, limits: desired }));
});
