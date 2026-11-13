import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { withEnvironmentConfigLock } from "./transient.ts";

export class ServiceWaitForChecksNotApplied extends Data.TaggedError(
  "Railway.ServiceWaitForChecksNotApplied",
)<{
  serviceId: string;
  environmentId: string;
  desired: boolean;
}> {
  override get message() {
    return `Railway service ${this.serviceId} did not report source.checkSuites ${this.desired} after it was written`;
  }
}

/** The slice of an environment config that holds `source.checkSuites`. */
const CheckSuitesConfig = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({
      source: Schema.Struct({
        checkSuites: Schema.Boolean.pipe(Schema.NullOr, Schema.optional),
      }).pipe(Schema.NullOr, Schema.optional),
    }).pipe(Schema.NullOr),
  ).pipe(Schema.NullOr, Schema.optional),
});

/**
 * `source.checkSuites` ("Wait for CI") for `serviceId` inside an
 * environment config. Railway omits it while it is off, so an absent key
 * reads as `false`. Fails with a `SchemaError` when the config does not
 * have the expected shape.
 */
export const serviceCheckSuites = (config: unknown, serviceId: string) =>
  Schema.decodeUnknownEffect(CheckSuitesConfig)(config).pipe(
    Effect.map((decoded) => decoded.services?.[serviceId]?.source?.checkSuites === true),
  );

interface ServiceTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly serviceId: string;
}

const readEnvironmentConfig = Query.fn((args: { id: string; projectId?: string }) => ({
  config: Railway.environment(args).config,
}));

// `skipDeploys`: this setting gates later deploys. Flipping it must not
// start one of its own.
const environmentPatchCommit = Query.fn(
  (args: { environmentId: string; commitMessage: string; patch: unknown; skipDeploys: boolean }) =>
    Railway.environmentPatchCommit(args),
);

const readCheckSuites = (target: ServiceTarget) =>
  readEnvironmentConfig({
    id: target.environmentId,
    ...(target.projectId.length > 0 ? { projectId: target.projectId } : {}),
  }).pipe(
    Effect.flatMap((environment) => serviceCheckSuites(environment.config, target.serviceId)),
  );

/**
 * Converge "Wait for CI" on a GitHub-sourced service. Railway's own IaC and
 * CLI write `source.checkSuites` in the environment config, so this reads
 * that config, patches only when it differs from `waitForChecks`, and waits
 * until the config reports the new value. Omitting `waitForChecks` leaves
 * the setting alone.
 */
export const syncCheckSuites = Effect.fn(function* (
  input: ServiceTarget & { readonly waitForChecks: boolean | undefined },
) {
  const desired = input.waitForChecks;
  if (desired === undefined) return;
  const applied = (observed: boolean) => observed === desired;

  const committed = yield* withEnvironmentConfigLock(
    input.environmentId,
    readCheckSuites(input).pipe(
      Effect.flatMap((observed) =>
        applied(observed)
          ? Effect.succeed(false)
          : environmentPatchCommit({
              environmentId: input.environmentId,
              commitMessage: `Set Railway service wait for CI to ${desired}`,
              patch: { services: { [input.serviceId]: { source: { checkSuites: desired } } } },
              skipDeploys: true,
            }).pipe(Effect.as(true)),
      ),
    ),
  );
  if (!committed) return;

  yield* readCheckSuites(input).pipe(
    Effect.repeat({ until: applied, schedule: Schedule.spaced("1 second"), times: 10 }),
    Effect.filterOrFail(
      applied,
      () =>
        new ServiceWaitForChecksNotApplied({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          desired,
        }),
    ),
  );
});
