import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const project =
  process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const organizationOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

export const waitUntilPostureGone = (name: string) =>
  securityposture.getOrganizationsLocationsPostures({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilDeploymentGone = (name: string) =>
  securityposture.getOrganizationsLocationsPostureDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const updatedPolicySets: securityposture.PolicySetList = [
  {
    policySetId: "alchemy",
    description: "updated alchemy policy set",
    policies: [
      {
        policyId: "alchemy-sha",
        constraint: {
          securityHealthAnalyticsModule: {
            moduleName: "API_KEY_EXISTS",
            moduleEnablementState: "DISABLED",
          },
        },
      },
      {
        policyId: "alchemy-sha-2",
        constraint: {
          securityHealthAnalyticsModule: {
            moduleName: "BUCKET_IAM_NOT_MONITORED",
            moduleEnablementState: "DISABLED",
          },
        },
      },
    ],
  },
];
