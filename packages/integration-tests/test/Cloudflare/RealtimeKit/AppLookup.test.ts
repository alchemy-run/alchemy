import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:realtimekit", "live"];

// RealtimeKit apps can't be deleted, so every suite shares one standing app
// (App.test.ts, Preset.test.ts). The target stack adopts it; destroying the
// stack only forgets it.
const APP_NAME = "alchemy-rtk-test-app";

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

const TargetStack = Alchemy.Stack(
  "RealtimeKitAppLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const app = yield* Cloudflare.RealtimeKit.App("lookup-target", { name: APP_NAME });
    return { appId: app.appId.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up app takes a new preset, by id and by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { appId } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.RealtimeKit.App.lookup({ name: APP_NAME });
        const byId = Cloudflare.RealtimeKit.App.lookup({ appId });
        const preset = yield* Cloudflare.RealtimeKit.Preset("app-lookup-preset", {
          appId: byName.appId,
          name: testName("alchemy-rtk-lookup-preset"),
        });
        return { presetId: preset.presetId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(APP_NAME);

      const live = yield* realtimeKit.getPresetByIdPreset({
        accountId,
        appId,
        presetId: out.presetId,
      });
      expect(live.data?.id).toBe(out.presetId);

      // A lookup re-resolves to the same app, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["app-lookup-preset"].action).toBe("noop");

      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing app fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("rtk-app-lookup-missing", {
            script: callerScript,
            env: { REF: Cloudflare.RealtimeKit.App.lookup({ name }).appId },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an app this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.RealtimeKit.App("lookup-managed", { name: APP_NAME });
      const { appId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("rtk-app-lookup-managed-caller", {
              script: callerScript,
              env: { REF: Cloudflare.RealtimeKit.App.lookup({ appId }).appId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
