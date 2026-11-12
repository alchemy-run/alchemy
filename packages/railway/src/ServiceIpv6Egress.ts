import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { withEnvironmentConfigLock } from "./transient.ts";

export class ServiceIpv6EgressNotApplied extends Data.TaggedError(
  "Railway.ServiceIpv6EgressNotApplied",
)<{
  serviceId: string;
  environmentId: string;
  desired: boolean;
  observed: boolean | undefined;
}> {
  override get message() {
    const where = this.observed === undefined ? "unset" : String(this.observed);
    return `Railway service ${this.serviceId} has ipv6EgressEnabled ${where} after requesting ${this.desired}`;
  }
}

class ServiceIpv6EgressPending extends Data.TaggedError("Railway.ServiceIpv6EgressPending")<{
  serviceId: string;
  desired: boolean;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `deploy.ipv6EgressEnabled` for `serviceId` inside an environment config.
 * `undefined` when Railway has not stored a value (the platform default).
 */
export const serviceIpv6Egress = (config: unknown, serviceId: string): boolean | undefined => {
  if (!isRecord(config)) return undefined;
  const services = config.services;
  if (!isRecord(services)) return undefined;
  const service = services[serviceId];
  if (!isRecord(service)) return undefined;
  const deploy = service.deploy;
  if (!isRecord(deploy)) return undefined;
  const enabled = deploy.ipv6EgressEnabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Patch that sets `deploy.ipv6EgressEnabled` to `desired`. `undefined` when
 * the observed value already matches.
 */
export const ipv6EgressPatch = (
  desired: boolean,
  observed: boolean | undefined,
): { ipv6EgressEnabled: boolean } | undefined =>
  observed === desired ? undefined : { ipv6EgressEnabled: desired };

const readEnvironmentConfig = Query.fn((args: { id: string; projectId?: string }) => ({
  config: Railway.environment(args).config,
}));

const environmentPatchCommit = Query.fn(
  (args: { environmentId: string; commitMessage: string; patch: unknown }) =>
    Railway.environmentPatchCommit(args),
);

const readObserved = (input: { environmentId: string; projectId: string; serviceId: string }) =>
  readEnvironmentConfig(
    input.projectId.length > 0
      ? { id: input.environmentId, projectId: input.projectId }
      : { id: input.environmentId },
  ).pipe(
    Effect.map((environment) => serviceIpv6Egress(environment.config, input.serviceId)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed(undefined)),
  );

/** IPv6 egress reported by the environment config, without writing. */
export const readServiceIpv6Egress = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
}) {
  if (input.environmentId.length === 0 || input.serviceId.length === 0) return undefined;
  return yield* readObserved(input);
});

const waitUntilIpv6Egress = (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  desired: boolean;
}) =>
  readServiceIpv6Egress(input).pipe(
    Effect.flatMap((observed) =>
      observed === input.desired
        ? Effect.succeed(input.desired)
        : Effect.fail(
            new ServiceIpv6EgressPending({ serviceId: input.serviceId, desired: input.desired }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Railway.ServiceIpv6EgressPending",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("Railway.ServiceIpv6EgressPending", () =>
      readServiceIpv6Egress(input).pipe(
        Effect.flatMap((observed) =>
          observed === input.desired
            ? Effect.succeed(input.desired)
            : Effect.fail(
                new ServiceIpv6EgressNotApplied({
                  serviceId: input.serviceId,
                  environmentId: input.environmentId,
                  desired: input.desired,
                  observed,
                }),
              ),
        ),
      ),
    ),
  );

/**
 * Set `deploy.ipv6EgressEnabled` to `enabled`, or read the current value
 * when `enabled` is omitted. The write goes through `environmentPatchCommit`
 * (`services[id].deploy`), the same patch Railway's own IaC applies.
 */
export const syncServiceIpv6Egress = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  enabled: boolean | undefined;
}) {
  if (input.enabled === undefined) return yield* readServiceIpv6Egress(input);
  const desired = input.enabled;
  const patched = yield* withEnvironmentConfigLock(
    input.environmentId,
    Effect.gen(function* () {
      const observed = yield* readObserved(input);
      const patch = ipv6EgressPatch(desired, observed);
      if (patch === undefined) return false;
      yield* environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage: `${desired ? "Enable" : "Disable"} Railway service IPv6 egress`,
        patch: { services: { [input.serviceId]: { deploy: patch } } },
      });
      return true;
    }),
  );
  if (!patched) return desired;
  return yield* waitUntilIpv6Egress({ ...input, desired });
});
