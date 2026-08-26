import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { hasGcpCreds, logLevel, project, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsRepositoriesWorkspaces on a missing workspace fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsRepositoriesWorkspaces({
          name: `projects/${project}/locations/us-central1/repositories/missing/workspaces/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create and delete a dataform workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* GCP.Dataform.Repository("WorkspaceRepo", {
            location: "us-central1",
            displayName: "workspace-repo",
            labels: { env: "test" },
          });
          const workspace = yield* GCP.Dataform.RepositoriesWorkspace("Dev", {
            repository: repo.name,
          });
          return { repo, workspace };
        }),
      );

      expect(created.workspace.name).toContain("/workspaces/");
      expect(created.workspace.repository).toEqual(created.repo.name);
      expect(created.workspace.disableMoves).toEqual(false);

      const fetched =
        yield* dataform.getProjectsLocationsRepositoriesWorkspaces({
          name: created.workspace.name,
        });
      expect(fetched.name).toEqual(created.workspace.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* GCP.Dataform.Repository("WorkspaceRepo", {
            repositoryId: created.repo.repositoryId,
            location: "us-central1",
            displayName: "workspace-repo",
            labels: { env: "test" },
          });
          const workspace = yield* GCP.Dataform.RepositoriesWorkspace("Dev", {
            repository: repo.name,
            workspaceId: created.workspace.workspaceId,
          });
          return { repo, workspace };
        }),
      );

      expect(updated.workspace.name).toEqual(created.workspace.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsRepositoriesWorkspaces({
          name: created.workspace.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
