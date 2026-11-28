import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { environmentPatchCommit, readEnvironmentConfig } from "./GraphQL.ts";
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

/** The slice of an environment config that holds `deploy.ipv6EgressEnabled`. */
const Ipv6EgressConfig = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({
      deploy: Schema.Struct({
        ipv6EgressEnabled: Schema.Boolean.pipe(Schema.NullOr, Schema.optional),
      }).pipe(Schema.NullOr, Schema.optional),
    }).pipe(Schema.NullOr),
  ).pipe(Schema.NullOr, Schema.optional),
});

/**
 * `deploy.ipv6EgressEnabled` for `serviceId` inside an environment config.
 * `None` when Railway has not stored a value (the platform default). Fails
 * with a `SchemaError` when the config does not have the expected shape.
 */
export const serviceIpv6Egress = (config: unknown, serviceId: string) =>
  Schema.decodeUnknownEffect(Ipv6EgressConfig)(config).pipe(
    Effect.map((decoded) =>
      Option.fromNullishOr(decoded.services?.[serviceId]?.deploy?.ipv6EgressEnabled),
    ),
  );

/**
 * Patch that sets `deploy.ipv6EgressEnabled` to `desired`. `None` when the
 * observed value already matches.
 */
export const ipv6EgressPatch = (desired: boolean, observed: Option.Option<boolean>) =>
  Option.contains(observed, desired) ? Option.none() : Option.some({ ipv6EgressEnabled: desired });

interface ServiceTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly serviceId: string;
}

const readObserved = (target: ServiceTarget) =>
  readEnvironmentConfig({
    id: target.environmentId,
    ...(target.projectId.length > 0 ? { projectId: target.projectId } : {}),
  }).pipe(
    Effect.flatMap((environment) => serviceIpv6Egress(environment.config, target.serviceId)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeedNone),
  );

/** IPv6 egress reported by the environment config, without writing. */
export const readServiceIpv6Egress = (target: ServiceTarget) =>
  target.environmentId.length === 0 || target.serviceId.length === 0
    ? Effect.succeedNone
    : readObserved(target);

/**
 * Set `deploy.ipv6EgressEnabled` to `enabled`, or read the current value
 * when `enabled` is omitted. The write goes through `environmentPatchCommit`
 * (`services[id].deploy`), the same patch Railway's own IaC applies, and
 * waits until the environment config reports it.
 */
export const syncServiceIpv6Egress = Effect.fn(function* (
  input: ServiceTarget & { readonly enabled: boolean | undefined },
) {
  if (input.enabled === undefined) return yield* readServiceIpv6Egress(input);
  const desired = input.enabled;

  const committed = yield* withEnvironmentConfigLock(
    input.environmentId,
    readObserved(input).pipe(
      Effect.flatMap((observed) =>
        Option.match(ipv6EgressPatch(desired, observed), {
          onNone: () => Effect.succeed(false),
          onSome: (deploy) =>
            environmentPatchCommit({
              environmentId: input.environmentId,
              commitMessage: `${desired ? "Enable" : "Disable"} Railway service IPv6 egress`,
              patch: { services: { [input.serviceId]: { deploy } } },
            }).pipe(Effect.as(true)),
        }),
      ),
    ),
  );
  if (!committed) return Option.some(desired);

  return yield* readObserved(input).pipe(
    Effect.repeat({
      until: Option.contains(desired),
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.filterOrFail(
      Option.contains(desired),
      (observed) =>
        new ServiceIpv6EgressNotApplied({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          desired,
          observed: Option.getOrUndefined(observed),
        }),
    ),
  );
});
