import { expect } from "@alchemy.run/test";
import { fromCloudFoundryPassword } from "@distilled.cloud/stackit/CloudFoundry";
import * as scf from "@distilled.cloud/stackit/scf";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment } from "../helpers.ts";

export { deployer } from "./fixtures/deployer.ts";

/**
 * Shared pieces of the Cloud Foundry suites.
 *
 * Organizations and spaces are free, and quotas aren't billed. A started app costs EUR
 * 0.00004093510 per MB and started hour, per hour or part thereof. So these aren't
 * cost-gated: every app here is 256 MB, about EUR 0.0105, and App, Route and the fixtures
 * start five in all, about EUR 0.05 per run. A managed `ServiceInstance` is priced by its
 * offering, so that case is gated on `STACKIT_TEST_CF_OFFERING` and `STACKIT_TEST_CF_PLAN`.
 */
export const CF_MEMORY_IN_MB = 256;

/**
 * What Cloud Foundry's own acceptance tests run. It serves HTTP on `PORT` and needs no
 * bundling, so an app suite needs no registry login. Whether STACKIT's platform allows
 * Docker images is what the first live run checks.
 */
export const EXAMPLE_IMAGE = "cloudfoundry/diego-docker-app:latest";

/** The project and region every suite deploys into. */
export const scfScope = stackitEnvironment.pipe(
  Effect.map((env) => ({ projectId: env.projectId, region: env.region })),
);

/** A deployed manager's login, as attributes hold it. */
export interface ManagerLogin {
  readonly apiUrl: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string> | undefined;
}

/** Run `cloud_foundry` calls out of band, as a deployed manager. */
export const asManager =
  (login: ManagerLogin) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        fromCloudFoundryPassword({
          apiUrl: login.apiUrl,
          username: login.username,
          password: login.password ?? Redacted.make(""),
        }),
      ),
    );

/** Bounded check that something reads as `NotFound`. */
export const expectGone = <A, E extends { readonly _tag: string }, R>(
  read: Effect.Effect<A, E, R>,
) =>
  read.pipe(
    Effect.as("present" as const),
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

/** An organization created out of band, for the cases about what isn't Alchemy's. */
export const foreignOrganization = (name: string) =>
  Effect.gen(function* () {
    const scope = yield* scfScope;
    const created = yield* scf.createOrganization({ ...scope, name });
    yield* scf.getOrganization({ ...scope, organizationId: created.guid }).pipe(
      Effect.retry({
        while: (error) => error._tag === "NotFound",
        schedule: Schedule.spaced("5 seconds"),
        times: 12,
      }),
    );
    return created.guid;
  });
