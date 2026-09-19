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

const htmlParameter = [
  { type: "template" as const, key: "html", value: "<script></script>" },
  { type: "boolean" as const, key: "supportDocumentWrite", value: "false" },
];

const waitUntilGone = (path: string) =>
  tagmanager.getAccountsContainersWorkspacesTags({ path }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsContainersWorkspacesTags on a missing tag fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tagmanager.getAccountsContainersWorkspacesTags({
          path: "accounts/0/containers/0/workspaces/0/tags/0",
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
  "create, update, and delete a workspace tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureParents("alchemy-tm2-tag", "web");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersWorkspacesTag("Pixel", {
            workspace: parent.workspacePath,
            type: "html",
            notes: "pixel",
            parameter: htmlParameter,
          });
        }),
      );

      expect(created.path).toContain("/tags/");
      expect(created.workspace).toEqual(parent.workspacePath);
      expect(created.type).toEqual("html");
      expect(created.notes).toEqual("pixel");
      expect(created.paused).toEqual(false);

      const fetched = yield* tagmanager.getAccountsContainersWorkspacesTags({
        path: created.path,
      });
      expect(fetched.path).toEqual(created.path);
      expect(fetched.type).toEqual("html");
      expect(fetched.notes).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersWorkspacesTag("Pixel", {
            workspace: parent.workspacePath,
            tagId: created.tagId,
            type: "html",
            notes: "pixel paused",
            paused: true,
            parameter: htmlParameter,
          });
        }),
      );

      expect(updated.path).toEqual(created.path);
      expect(updated.notes).toEqual("pixel paused");
      expect(updated.paused).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.path);
      expect(gone).toEqual("gone");

      yield* deleteContainer(parent.containerPath);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
