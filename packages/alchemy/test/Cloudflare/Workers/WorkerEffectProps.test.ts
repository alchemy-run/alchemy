import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import * as Effect from "effect/Effect";
import { expectUrlContains } from "../Utils/Http.ts";
import EffectPropsWorker from "./fixtures/effect-props-worker.ts";

const { beforeAll, afterAll, deploy, destroy, test } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "WorkerEffectPropsTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* EffectPropsWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * The class form accepts an Effect of props (see
 * WorkerEffectProps.types.ts for the compile-time contract). This test
 * pins the runtime half: the props effect yields `Stage`, which the
 * Worker bridge must provide inside the deployed isolate — the fixture
 * echoes the props-derived value, so a missing `Stage` (init defect,
 * every request 500s) or a dropped env binding fails the marker check.
 */
test(
  "class-form worker with Stage-dependent Effect props deploys and serves",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const body = yield* expectUrlContains(url, "effect-props-stage:", {
      label: "effect-props-worker",
    });
    // The stage suffix is the live value the props effect computed at
    // runtime — assert it's non-empty rather than pinning the test
    // runner's stage name.
    const stage = body.split("effect-props-stage:")[1]?.trim();
    if (!stage) {
      return yield* Effect.die(
        new Error(`props-derived stage missing from body: ${body}`),
      );
    }
  }),
  { timeout: 180_000 },
);
