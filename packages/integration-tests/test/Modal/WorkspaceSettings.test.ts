import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workspace from "@distilled.cloud/modal/workspace";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

test.provider(
  "set the default environment and restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* workspace.workspaceSettings({});

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const env = yield* Modal.Environment("DefaultEnv", {});
          yield* Modal.WorkspaceSettings("Settings", { defaultEnvironment: env });
          return env;
        }),
      );
      expect((yield* workspace.workspaceSettings({})).defaultEnvironmentName).toBe(deployed.name);

      yield* stack.destroy();
      expect((yield* workspace.workspaceSettings({})).defaultEnvironmentName).toBe(
        before.defaultEnvironmentName,
      );
    }),
  {
    tags: ["provider:modal", "provider:modal:workspace", "live"],
    timeout: 120_000,
    // The default environment is workspace-wide: every test that names no
    // environment would land in this one while it is set, so nothing runs
    // alongside.
    exclusive: true,
  },
);
