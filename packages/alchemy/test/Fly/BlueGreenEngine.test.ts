import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertAppGone } from "./fixtures/bluegreen.ts";
import { engineActor } from "./fixtures/actors.ts";
import { transportProxy } from "./fixtures/transport.ts";

const file = "test/Fly/BlueGreenEngine.test.ts";
const title =
  "F07 F11 fresh engine contexts reopen real durable LocalState without recreating the App";
const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  title,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const proxy = yield* transportProxy();
      const firstActor = yield* engineActor(stack, title, file, proxy.url);
      const first = yield* firstActor
        .deploy(Fly.App("Site"))
        .pipe(Effect.scoped);
      const secondActor = yield* engineActor(stack, title, file, proxy.url);
      expect(secondActor.state).not.toBe(firstActor.state);
      const second = yield* secondActor
        .deploy(Fly.App("Site"))
        .pipe(Effect.scoped);
      expect(second.appName).toBe(first.appName);
      expect(second.appId).toBe(first.appId);
      expect(
        proxy.events.filter(
          (event) =>
            event.stage === "completed" &&
            event.method === "POST" &&
            event.path === "/v1/apps" &&
            event.status! < 300,
        ),
      ).toHaveLength(1);
      yield* stack.destroy();
      yield* assertAppGone(first.appName);
    }).pipe(Effect.scoped),
  { timeout: 180_000 },
);
