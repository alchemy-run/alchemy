import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as app from "@distilled.cloud/modal/app";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Modal.providers() });

test.provider(
  "create, tag, and stop an app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.App("App", { tags: { team: "platform" } });
        }),
      );
      yield* expectFound(Modal.App.lookup({ name: created.name }), created);
      expect(created.appId).toMatch(/^ap-/);
      const { tags } = yield* app.appGetTags({ appId: created.appId });
      expect(tags?.team).toBe("platform");
      expect(tags?.["alchemy.id"]).toBe("App");

      const retagged = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.App("App", { tags: { team: "infra" } });
        }),
      );
      expect(retagged.appId).toBe(created.appId);
      expect((yield* app.appGetTags({ appId: created.appId })).tags?.team).toBe("infra");

      yield* stack.destroy();
      const { apps } = yield* app.listApp({ environmentName: "" });
      const after = (apps ?? []).find((item) => item.appId === created.appId);
      expect(
        after === undefined ||
          after.state === "APP_STATE_STOPPED" ||
          after.state === "APP_STATE_STOPPING",
      ).toBe(true);
    }),
  { tags: ["provider:modal", "provider:modal:app", "live"], timeout: 120_000 },
);
