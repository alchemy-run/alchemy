import { HarborCredentials, harborCredentialsOf } from "@distilled.cloud/stackit/Credentials";
import * as registry from "@distilled.cloud/stackit/registry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Shared pieces of the STACKIT Container Registry suites.
 *
 * Anything touching the registry's own Harbor API needs a Harbor identity no
 * STACKIT credential provides: `STACKIT_TEST_HARBOR_USERNAME` and
 * `STACKIT_TEST_HARBOR_SECRET` (a user's CLI secret, from the user profile in the
 * registry UI). Those cases are skipped without them; the rest run ungated,
 * because Container Registry is free of charge during its beta.
 */
export const noHarborIdentity =
  !process.env.STACKIT_TEST_HARBOR_USERNAME || !process.env.STACKIT_TEST_HARBOR_SECRET;

/** The Harbor identity the suites bootstrap robots with, as resource props. */
export const harborIdentity = {
  username: Config.String("STACKIT_TEST_HARBOR_USERNAME"),
  secret: Config.Redacted("STACKIT_TEST_HARBOR_SECRET"),
};

/** Run a `registry_harbor` call out of band, as the suite's Harbor identity. */
export const asHarborUser =
  (registryUrl: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const username = yield* harborIdentity.username;
      const secret = yield* harborIdentity.secret;
      return yield* Effect.provideService(
        effect,
        HarborCredentials,
        harborCredentialsOf({ registryUrl, username, secret }),
      );
    });

/** Run a `registry_harbor` call out of band, as a robot. */
export const asRobot =
  (robot: {
    readonly registryUrl: string;
    readonly robotName: string;
    readonly secret: Redacted.Redacted<string>;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      effect,
      HarborCredentials,
      harborCredentialsOf({
        registryUrl: robot.registryUrl,
        username: robot.robotName,
        secret: robot.secret,
      }),
    );

/** Out of band: the registry project, or "gone" (typed NotFound or `Deleted`). */
export const observeProject = (projectId: string, region: string, artifactoryId: string) =>
  registry.getArtifactory({ projectId, regionId: region, artifactoryId }).pipe(
    Effect.map((artifactory) =>
      artifactory.state === "Deleted" ? ("gone" as const) : artifactory,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Bounded wait (~90s) until the registry project is gone. */
export const waitUntilProjectGone = (projectId: string, region: string, artifactoryId: string) =>
  observeProject(projectId, region, artifactoryId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (project) => project === "gone",
      times: 30,
    }),
  );
