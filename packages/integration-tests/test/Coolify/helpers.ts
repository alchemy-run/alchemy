import * as Coolify from "@distilled.cloud/coolify";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * The Coolify suite runs against a Coolify instance set aside for it, with
 * a token whose access is limited to one test project (Keys & Tokens → API
 * tokens → Access: selected projects), so it can never reach real projects.
 * The token needs `read`, `read:sensitive`, `write`, `deploy` and `delete`.
 *
 * - `COOLIFY_TOKEN`, `COOLIFY_API_BASE_URL` — the token and instance.
 * - `COOLIFY_TEST_PROJECT_UUID` — the project the token is scoped to. Every
 *   test creates its own environment inside it.
 * - `COOLIFY_TEST_SERVER_UUID` — a server the token may deploy applications
 *   and databases to. A scoped token can't list servers, so it comes from
 *   config. Coolify reserves the server it runs on for team admins, so this
 *   is any other server, or the Coolify host with an admin's token.
 * - `COOLIFY_TEST_HOST_SERVER_UUID` — the server that runs Coolify. With a
 *   non-admin token, a probe asserts deploying there fails with
 *   `CoolifyHostRequiresAdmin`.
 * - `COOLIFY_TEST_CREATE_PROJECTS=1` — only with a team-wide token: runs the
 *   `Coolify.Project` create/delete lifecycle, which a scoped token can't.
 */
export const hasToken = !!process.env.COOLIFY_TOKEN;
export const hasProject = hasToken && !!process.env.COOLIFY_TEST_PROJECT_UUID;
export const hasServer = hasProject && !!process.env.COOLIFY_TEST_SERVER_UUID;
export const hasHostServer = hasProject && !!process.env.COOLIFY_TEST_HOST_SERVER_UUID;
export const canCreateProjects = hasToken && process.env.COOLIFY_TEST_CREATE_PROJECTS === "1";

/** UUID of the project the test token is scoped to. */
export const testProject = Config.String("COOLIFY_TEST_PROJECT_UUID");

/** UUID of the server applications and databases deploy to. */
export const testServer = Config.String("COOLIFY_TEST_SERVER_UUID");

/** UUID of the server that runs Coolify itself. */
export const hostServer = Config.String("COOLIFY_TEST_HOST_SERVER_UUID");

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
