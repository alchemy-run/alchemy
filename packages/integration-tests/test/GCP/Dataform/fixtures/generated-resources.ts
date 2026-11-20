import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Dataform resources the generated bindings bind. */
export const ProbeRepo = GCP.Dataform.Repository("ProbeRepo", {
  location: "us-central1",
  displayName: "probe-repo",
});
export const ProbeWorkspace = Effect.gen(function* () {
  const repo = yield* ProbeRepo;
  return yield* GCP.Dataform.RepositoriesWorkspace("ProbeWorkspace", { repository: repo.name });
});
export const ProbeFolder = GCP.Dataform.ProjectsLocationsFolder("ProbeFolder", {
  location: "us-central1",
  displayName: "probe-folder",
});
export const ProbeTeam = GCP.Dataform.Team("ProbeTeam", {
  location: "us-central1",
  displayName: "probe-team",
});
/** A disabled release config: it never compiles on schedule. */
export const ProbeReleaseConfig = Effect.gen(function* () {
  const repo = yield* ProbeRepo;
  return yield* GCP.Dataform.RepositoriesReleaseConfig("ProbeReleaseConfig", {
    repository: repo.name,
    gitCommitish: "main",
    disabled: true,
  });
});
/** A disabled workflow config: it never invokes on schedule. */
export const ProbeWorkflowConfig = Effect.gen(function* () {
  const project = yield* deployProject;
  const repo = yield* ProbeRepo;
  const release = yield* ProbeReleaseConfig;
  return yield* GCP.Dataform.RepositoriesWorkflowConfig("ProbeWorkflowConfig", {
    repository: repo.name,
    releaseConfig: release.name,
    disabled: true,
    invocationConfig: { serviceAccount: `alchemy-testing@${project}.iam.gserviceaccount.com` },
  });
});
