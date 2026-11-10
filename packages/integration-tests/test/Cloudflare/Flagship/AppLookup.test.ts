import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:flagship", "live"];

// Reports whether the looked-up app arrived as a native flagship binding.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response("flags:" + typeof env.FLAGS);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
// It is declared without props, which must work: every prop is optional.
const TargetStack = Alchemy.Stack(
  "FlagshipAppLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const app = yield* Cloudflare.Flagship.App("lookup-target");
    return { appId: app.appId.as<string>(), name: app.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up app takes a new flag and binds to a Worker, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { appId, name } = yield* target;
      // Flagship's app list is eventually consistent: a new app appears
      // about ten seconds after it is created. Wait for it before looking
      // the app up by name.
      yield* flagship.listApps({ accountId }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (page) => page.result.some((app) => app.id === appId),
          times: 30,
        }),
      );

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Flagship.App.lookup({ name });
        const byId = Cloudflare.Flagship.App.lookup({ appId });
        const flag = yield* Cloudflare.Flagship.Flag("app-lookup-flag", {
          appId: byName.appId,
          key: "alchemy-lookup-flag",
          defaultVariation: "off",
          variations: { off: false, on: true },
        });
        const caller = yield* Cloudflare.Worker("app-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { FLAGS: byId },
        });
        return { url: caller.url.as<string>(), flagAppId: flag.appId };
      });
      const out = yield* stack.deploy(program);
      expect(out.flagAppId).toBe(appId);

      const live = yield* flagship.getAppFlag({ accountId, appId, flagKey: "alchemy-lookup-flag" });
      expect(live.key).toBe("alchemy-lookup-flag");

      yield* expectUrlContains(out.url, "flags:object", { label: "flagship lookup caller" });

      // A lookup re-resolves to the same app, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["app-lookup-flag"].action).toBe("noop");
      expect(plan.resources["app-lookup-caller"].action).toBe("noop");

      // Destroying the stack removes its flag but leaves the app.
      yield* stack.destroy();
      const survivor = yield* flagship.getApp({ accountId, appId });
      expect(survivor.name).toBe(name);
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
          Cloudflare.Worker("app-lookup-missing", {
            script: callerScript,
            env: { FLAGS: Cloudflare.Flagship.App.lookup({ name }) },
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
      const managed = () => Cloudflare.Flagship.App("lookup-managed");
      const { appId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("app-lookup-managed-caller", {
              script: callerScript,
              env: { FLAGS: Cloudflare.Flagship.App.lookup({ appId }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
