import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_ACCESSCONTEXTMANAGER;

export const runProbe =
  hasGcpCreds && !process.env.GCP_TEST_ACCESSCONTEXTMANAGER;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectContext = () =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const parent = resource.parent ?? "";
      return {
        projectNumber: lastSegment(resource.name ?? ""),
        parent,
        organization: parent.startsWith("organizations/") ? parent : undefined,
      };
    }),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed({
        projectNumber: "",
        parent: "",
        organization: undefined as string | undefined,
      }),
    ),
  );
