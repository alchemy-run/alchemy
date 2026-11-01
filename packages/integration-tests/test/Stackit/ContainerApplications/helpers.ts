import { expect } from "@alchemy.run/test";
import * as sca from "@distilled.cloud/stackit/sca";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { noHarborIdentity } from "../ContainerRegistry/harbor.ts";
import { stackitEnvironment } from "../helpers.ts";
import { slow } from "../IaaS/compute.ts";

/**
 * Applications are compute, and the price list has no SKU for them, so every suite that
 * starts one is gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`. Environments,
 * secrets and registry logins run no compute and stay ungated.
 */
export const noApplications = slow;

/** Applications built from `main` also need a registry login. */
export const noBuiltApplications = noApplications || noHarborIdentity;

/** The image in the spec's own example. It listens on 8080. */
export const EXAMPLE_IMAGE = "nginxinc/nginx-unprivileged";

/**
 * The API can't delete an environment, so these suites share one, created here once and
 * kept: a resource in each test would leave one behind per test. `Environment.test.ts` and
 * the deployed fixtures use the resource itself.
 */
const SHARED_ENVIRONMENT = "alchemy-test-sca-shared";

const waitForEnvironment = (projectId: string, region: string, environmentId: string) =>
  sca.getEnvironment({ projectId, region, environmentId }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (environment) => environment.status?.current === "CURRENT_STATUS_CREATED",
      times: 40,
    }),
  );

/** Find or create a test-owned environment out of band, and wait until it is ready. */
export const ensureTestEnvironment = (displayName: string) =>
  Effect.gen(function* () {
    const { projectId, region } = yield* stackitEnvironment;
    const find = sca
      .listEnvironments({ projectId, region })
      .pipe(Effect.map(({ items }) => items?.find((item) => item.displayName === displayName)));
    const existing = yield* find;
    const environment =
      existing ??
      (yield* sca.createEnvironment({ projectId, region, displayName }).pipe(
        // Suites run concurrently, and another one may have just created it.
        Effect.catchTag("Conflict", (conflict) =>
          find.pipe(
            Effect.flatMap((found) =>
              found === undefined ? Effect.fail(conflict) : Effect.succeed(found),
            ),
          ),
        ),
      ));
    yield* waitForEnvironment(projectId, region, environment.id!);
    return { projectId, region, environmentId: environment.id! };
  });

/** The shared environment of the suites that don't test environments. */
export const sharedEnvironment = ensureTestEnvironment(SHARED_ENVIRONMENT);

/** Bounded check that an application is gone, by its typed `NotFound`. */
export const expectApplicationGone = (
  scope: { projectId: string; region: string; environmentId: string },
  applicationId: string,
) =>
  sca.getApplication({ ...scope, applicationId }).pipe(
    Effect.as("present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 36,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

/** The keys of an environment's secrets. */
export const secretKeys = (scope: { projectId: string; region: string; environmentId: string }) =>
  sca
    .listEnvironmentSecrets(scope)
    .pipe(Effect.map(({ secrets }) => secrets.map((secret) => secret.key)));

/** The servers of an environment's registries. */
export const registryServers = (scope: {
  projectId: string;
  region: string;
  environmentId: string;
}) =>
  sca
    .listEnvironmentRegistries(scope)
    .pipe(Effect.map(({ registries }) => registries.map((registry) => registry.server)));
