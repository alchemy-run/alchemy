import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_SECURE_SOURCE_MANAGER;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const missingRepoOf = (project: string) =>
  `projects/${project}/locations/us-central1/repositories/alchemy-missing-ssm-repo`;

export const missingIssueOf = (project: string) =>
  `${missingRepoOf(project)}/issues/alchemy-missing-issue`;

export const missingPullRequestOf = (project: string) =>
  `${missingRepoOf(project)}/pullRequests/alchemy-missing-pr`;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
