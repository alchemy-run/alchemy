import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

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
