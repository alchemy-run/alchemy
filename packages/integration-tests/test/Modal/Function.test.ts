import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as app from "@distilled.cloud/modal/app";
import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

const main = new URL("./fixtures/lifecycle-program.ts", import.meta.url).pathname;

const deployFunction = (props: Omit<Modal.FunctionProps, "main" | "app">) =>
  Effect.gen(function* () {
    const environment = yield* Modal.Environment("FunctionLifecycleEnv", {});
    const target = yield* Modal.App("FunctionLifecycleApp", { environment });
    const fn = yield* Modal.Function("Lifecycle", { main, app: target, ...props });
    return { fn, appId: target.appId };
  });

test.provider(
  "deploy, update in place, schedule, rename and remove a function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(deployFunction({ env: { VERSION: "1" } }));
      expect(first.fn.functionId).toMatch(/^fu-/);
      const layout = yield* app.appGetLayout({ appId: first.appId });
      expect(layout.appLayout?.functionIds?.Lifecycle).toBe(first.fn.functionId);

      // An env change updates the function in place.
      const second = yield* stack.deploy(
        deployFunction({ env: { VERSION: "2" }, timeout: "2 minutes" }),
      );
      expect(second.fn.functionId).toBe(first.fn.functionId);
      const definition = yield* functions.functionGetById({ functionId: second.fn.functionId });
      expect(definition.function?.timeoutSecs).toBe(120);

      // A schedule is part of the definition.
      const scheduled = yield* stack.deploy(
        deployFunction({ env: { VERSION: "2" }, schedule: { cron: "0 0 1 1 *" } }),
      );
      const withSchedule = yield* functions.functionGetById({
        functionId: scheduled.fn.functionId,
      });
      expect(withSchedule.function?.schedule?.cron?.cronString).toBe("0 0 1 1 *");

      // A new name is a new function; the old name leaves the App.
      const renamed = yield* stack.deploy(
        deployFunction({ env: { VERSION: "2" }, name: "Renamed" }),
      );
      const afterRename = yield* app.appGetLayout({ appId: renamed.appId });
      expect(Object.keys(afterRename.appLayout?.functionIds ?? {})).toEqual(["Renamed"]);

      yield* stack.destroy();
      const { apps } = yield* app.listApp({ environmentName: "" });
      const stopped = (apps ?? []).find((item) => item.appId === renamed.appId);
      expect(
        stopped === undefined ||
          stopped.state === "APP_STATE_STOPPED" ||
          stopped.state === "APP_STATE_STOPPING",
      ).toBe(true);
    }),
  { tags: ["provider:modal", "provider:modal:function", "live"], timeout: 900_000 },
);
