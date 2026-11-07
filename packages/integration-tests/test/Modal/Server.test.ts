import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as app from "@distilled.cloud/modal/app";
import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

const main = new URL("./fixtures/lifecycle-program.ts", import.meta.url).pathname;

const deployServer = (props: Omit<Modal.ServerProps, "main" | "app">) =>
  Effect.gen(function* () {
    const environment = yield* Modal.Environment("ServerLifecycleEnv", {});
    const target = yield* Modal.App("ServerLifecycleApp", { environment });
    const server = yield* Modal.Server("Lifecycle", { main, app: target, ...props });
    return { server, appId: target.appId };
  });

test.provider(
  "deploy and update a server, then remove it from its App",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(deployServer({ env: { VERSION: "1" } }));
      expect(first.server.url).toMatch(/^https:\/\//);
      const created = yield* functions.functionGetById({ functionId: first.server.functionId });
      expect(created.function?.isServer).toBe(true);
      expect(created.function?.httpConfig?.unauthenticated).toBeFalsy();

      const second = yield* stack.deploy(
        deployServer({ env: { VERSION: "2" }, unauthenticated: true, maxConcurrency: 10 }),
      );
      expect(second.server.functionId).toBe(first.server.functionId);
      const updated = yield* functions.functionGetById({ functionId: second.server.functionId });
      expect(updated.function?.httpConfig?.unauthenticated).toBe(true);

      yield* stack.destroy();
      const { apps } = yield* app.listApp({ environmentName: "" });
      const stopped = (apps ?? []).find((item) => item.appId === second.appId);
      expect(
        stopped === undefined ||
          stopped.state === "APP_STATE_STOPPED" ||
          stopped.state === "APP_STATE_STOPPING",
      ).toBe(true);
    }),
  { tags: ["provider:modal", "provider:modal:server", "live"], timeout: 900_000 },
);
