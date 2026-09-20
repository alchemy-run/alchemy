import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import type { MachineProps } from "@/Fly/Machine";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { assertAppGone, census, checks } from "./fixtures/bluegreen.ts";
import MountedBlueGreen from "./fixtures/mounted-bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });
const invalid: Array<[string, Partial<MachineProps>]> = [
  ["direct volume", { mounts: [{ path: "/data", sizeGb: 1 }] }],
  ["skipLaunch", { skipLaunch: true }],
  ["autoDestroy", { autoDestroy: true }],
  ["restart=no", { restart: { policy: "no" } }],
  ["missing checks", { checks: {} }],
  [
    "unchecked public service",
    { services: [{ internalPort: 80, ports: [{ port: 80 }] }] },
  ],
];

describe.sequential("pre-mutation validation", () => {
  for (const [label, props] of invalid) {
    test.provider(
      `${label === "direct volume" ? "S10" : "S11"} ${label} rejects before any Machine mutation`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          const proxy = yield* transportProxy();
          yield* Effect.sync(() => {
            endpoint = proxy.url;
          });
          const failed = yield* stack
            .deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  checks,
                  deploy: { strategy: "bluegreen" },
                  ...props,
                });
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(failed)).toBe(true);
          if (Result.isFailure(failed))
            expect(failed.failure).toMatchObject({
              _tag: "Fly.InvalidDeployment",
            });
          expect(
            proxy.events.some(
              (event) =>
                event.method !== "GET" &&
                /\/(machines|volumes)(\/|$)/.test(event.path),
            ),
          ).toBe(false);
          expect(yield* census(app.appName)).toHaveLength(0);
          expect(
            yield* machines.listVolumes({ app_name: app.appName }),
          ).toHaveLength(0);
          yield* Effect.sync(() => {
            endpoint = undefined;
          });
          yield* stack.destroy();
          yield* assertAppGone(app.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 180_000 },
    );
  }

  test.provider(
    "S10 resolved MountVolume binding rejects before Machine or Volume mutation",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const app = yield* stack.deploy(Fly.App("Site"));
        const proxy = yield* transportProxy();
        yield* Effect.sync(() => {
          endpoint = proxy.url;
        });
        const failed = yield* stack
          .deploy(MountedBlueGreen)
          .pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed))
          expect(failed.failure).toMatchObject({
            _tag: "Fly.InvalidDeployment",
          });
        expect(
          proxy.events.some(
            (event) =>
              event.method !== "GET" &&
              /\/(machines|volumes)(\/|$)/.test(event.path),
          ),
        ).toBe(false);
        expect(yield* census(app.appName)).toHaveLength(0);
        expect(
          yield* machines.listVolumes({ app_name: app.appName }),
        ).toHaveLength(0);
        yield* Effect.sync(() => {
          endpoint = undefined;
        });
        yield* stack.destroy();
        yield* assertAppGone(app.appName);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            endpoint = undefined;
          }),
        ),
      ),
    { timeout: 300_000 },
  );
});
