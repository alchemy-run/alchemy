import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteContainer, ensureParents } from "./parent.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const waitUntilGone = (path: string) =>
  tagmanager.getAccountsContainersWorkspacesClients({ path }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsContainersWorkspacesClients on a missing client fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tagmanager.getAccountsContainersWorkspacesClients({
          path: "accounts/0/containers/0/workspaces/0/clients/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_TAGMANAGER,
)(
  "create, update, and delete a workspace client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureParents("alchemy-tm2-cli", "server");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersWorkspacesClient("Ga4", {
            workspace: parent.workspacePath,
            type: "gaaw",
            notes: "ga4 client",
            parameter: [
              { type: "template", key: "measurementId", value: "G-TEST000000" },
            ],
          });
        }),
      );

      expect(created.path).toContain("/clients/");
      expect(created.workspace).toEqual(parent.workspacePath);
      expect(created.type).toEqual("gaaw");
      expect(created.notes).toEqual("ga4 client");

      const fetched = yield* tagmanager.getAccountsContainersWorkspacesClients({
        path: created.path,
      });
      expect(fetched.path).toEqual(created.path);
      expect(fetched.type).toEqual("gaaw");
      expect(fetched.notes).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersWorkspacesClient("Ga4", {
            workspace: parent.workspacePath,
            clientId: created.clientId,
            type: "gaaw",
            notes: "ga4 client v2",
            priority: 10,
            parameter: [
              { type: "template", key: "measurementId", value: "G-TEST000000" },
            ],
          });
        }),
      );

      expect(updated.path).toEqual(created.path);
      expect(updated.notes).toEqual("ga4 client v2");
      expect(updated.priority).toEqual(10);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.path);
      expect(gone).toEqual("gone");

      yield* deleteContainer(parent.containerPath);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
