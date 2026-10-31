import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/**
 * Developer Connect resources the generated bindings bind. A connection
 * without a GitHub install stays PENDING_USER_OAUTH, which is enough to
 * read and update it.
 */
export const ProbeConnection = GCP.DeveloperConnect.Connection("ProbeGithub", {
  location: "us-central1",
  githubConfig: { githubApp: "DEVELOPER_CONNECT" },
});
export const ProbeAccountConnector = GCP.DeveloperConnect.AccountConnector("ProbeAccounts", {
  location: "us-central1",
  providerOauthConfig: { systemProviderId: "GITHUB", scopes: ["repo"] },
});
export const ProbeInsights = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.DeveloperConnect.InsightsConfig("ProbeInsights", {
    location: "us-central1",
    projects: { projectIds: [project] },
  });
});
