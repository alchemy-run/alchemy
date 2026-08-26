import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as firebase from "@distilled.cloud/gcp/firebase_v1beta1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const project =
  process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

export const APP_CHECK_DISABLED = "Firebase App Check API has not been used";

export const FIREBASE_DISABLED = "Firebase Management API has not been used";

export const probeTags = ["NotFound", "Forbidden"] as const;

export const missingDebugToken = () =>
  `projects/${project}/apps/1:0:web:deadbeef/debugTokens/missing`;

export const missingResourcePolicy = () =>
  `projects/${project}/services/oauth2.googleapis.com/resourcePolicies/missing`;

export const probeAppCheck = () =>
  firebaseappcheck
    .getProjectsAppsDebugTokens({ name: missingDebugToken() })
    .pipe(
      Effect.as("enabled" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("enabled" as const)),
      Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
    );

export const resolveAppId = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GCP_TEST_FIREBASE_APP_ID;
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    const page = yield* firebase
      .searchAppsProjects({
        parent: `projects/${project}`,
        pageSize: 10,
      })
      .pipe(
        Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({ apps: [] as const }),
        ),
      );
    if ("_tag" in page) return page;
    const existing = page.apps?.find((app) => (app.appId ?? "").length > 0);
    if (existing?.appId) return existing.appId;
    const created = yield* firebase
      .createProjectsWebApps({
        parent: `projects/${project}`,
        body: { displayName: "alchemy-appcheck" },
      })
      .pipe(
        Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
        Effect.catchTag("BadRequest", (error) => Effect.succeed(error)),
        Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
      );
    if ("_tag" in created) return created;
    const appId = (created.response as { appId?: string } | undefined)?.appId;
    if (appId && appId.length > 0) return appId;
    return "missing" as const;
  });

export const waitUntilDebugTokenGone = (name: string) =>
  firebaseappcheck.getProjectsAppsDebugTokens({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilResourcePolicyGone = (name: string) =>
  firebaseappcheck.getProjectsServicesResourcePolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
