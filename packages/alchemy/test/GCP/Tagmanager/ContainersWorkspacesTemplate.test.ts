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

const templateData = `___INFO___

{
  "type": "MACRO",
  "id": "cvt_temp_id",
  "version": 1,
  "displayName": "const",
  "containerContexts": ["WEB"]
}


___TEMPLATE_PARAMETERS___

[]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

return 'alchemy';


___TESTS___

[]


___NOTES___

`;

const waitUntilGone = (path: string) =>
  tagmanager.getAccountsContainersWorkspacesTemplates({ path }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsContainersWorkspacesTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tagmanager.getAccountsContainersWorkspacesTemplates({
          path: "accounts/0/containers/0/workspaces/0/templates/0",
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
  "create, update, and delete a workspace template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureParents("alchemy-tm2-tpl", "web");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersWorkspacesTemplate("Const", {
            workspace: parent.workspacePath,
            name: "const",
            templateData,
          });
        }),
      );

      expect(created.path).toContain("/templates/");
      expect(created.workspace).toEqual(parent.workspacePath);
      expect(created.name).toEqual("const");
      expect(created.templateData).toContain("return 'alchemy'");

      const fetched =
        yield* tagmanager.getAccountsContainersWorkspacesTemplates({
          path: created.path,
        });
      expect(fetched.path).toEqual(created.path);
      expect(fetched.name).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersWorkspacesTemplate("Const", {
            workspace: parent.workspacePath,
            templateId: created.templateId,
            name: "const-v2",
            templateData,
          });
        }),
      );

      expect(updated.path).toEqual(created.path);
      expect(updated.name).toEqual("const-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.path);
      expect(gone).toEqual("gone");

      yield* deleteContainer(parent.containerPath);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
