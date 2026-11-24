import * as Coolify from "@distilled.cloud/coolify";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * The Coolify suite needs a Coolify instance of its own: tests create and
 * delete projects, applications and databases on it. Point the `testing`
 * profile (or `COOLIFY_TOKEN` + `COOLIFY_API_BASE_URL`) at that instance,
 * with a token that has `read`, `write`, `deploy` and `read:sensitive`.
 *
 * The suite runs only with `COOLIFY_TEST=1`, because a `.env` may carry a
 * `COOLIFY_TOKEN` for a Coolify you deploy to for real: the tests create and
 * delete projects, and must never touch a production instance. Projects and
 * environments then need only the token. Applications and databases run on a
 * server, so they also need `COOLIFY_TEST_SERVER_UUID` (the test instance's
 * `localhost` server works).
 */
export const hasToken = process.env.COOLIFY_TEST === "1" && !!process.env.COOLIFY_TOKEN;
export const hasServer = hasToken && !!process.env.COOLIFY_TEST_SERVER_UUID;

/** UUID of the server applications and databases deploy to. */
export const testServer = Config.String("COOLIFY_TEST_SERVER_UUID");

const gone = <E, R>(probe: Effect.Effect<unknown, E, R>, isMissing: (e: E) => boolean) =>
  probe.pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

export const projectGone = (uuid: string) =>
  gone(Coolify.getProject({ uuid }), (e) => e._tag === "NotFound");

export const environmentGone = (projectUuid: string, environmentUuid: string) =>
  gone(
    Coolify.getEnvironmentByNameOrUuid({
      uuid: projectUuid,
      environment_name_or_uuid: environmentUuid,
    }),
    (e) => e._tag === "NotFound",
  );

export const applicationGone = (uuid: string) =>
  gone(Coolify.getApplication({ uuid }), (e) => e._tag === "NotFound");

export const databaseGone = (uuid: string) =>
  gone(Coolify.getDatabase({ uuid }), (e) => e._tag === "NotFound");
