import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as turnstile from "@distilled.cloud/cloudflare/turnstile";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:turnstile", "live"];

const zoneName = "alchemy-test-2.us";

// Reports the sitekey found by name and whether the secret found by sitekey
// arrived; the secret itself never leaves the Worker.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response("sitekey:" + env.SITEKEY + " secret:" + (env.SECRET.length > 0));
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "TurnstileWidgetLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const widget = yield* Cloudflare.Turnstile.Widget("lookup-target", {
      domains: [zoneName],
      mode: "managed",
    });
    return { sitekey: widget.sitekey.as<string>(), name: widget.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up widget hands its sitekey and secret to a Worker, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { sitekey, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Turnstile.Widget.lookup({ name });
        const caller = yield* Cloudflare.Worker("turnstile-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: {
            SITEKEY: byName.sitekey,
            SECRET: Cloudflare.Turnstile.Widget.lookup({ sitekey }).secret,
          },
        });
        return { url: caller.url.as<string>(), sitekey: byName.sitekey };
      });
      const out = yield* stack.deploy(program);
      expect(out.sitekey).toBe(sitekey);

      yield* expectUrlContains(out.url, `sitekey:${sitekey} secret:true`, {
        label: "turnstile lookup caller",
      });

      // A lookup re-resolves to the same widget, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["turnstile-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the widget alone.
      yield* stack.destroy();
      const survivor = yield* turnstile.getWidget({ accountId, sitekey });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing widget fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("turnstile-lookup-missing", {
            script: callerScript,
            env: { SITEKEY: Cloudflare.Turnstile.Widget.lookup({ name }).sitekey },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a widget this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Turnstile.Widget("lookup-managed", { domains: [zoneName], mode: "managed" });
      const { sitekey } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("turnstile-lookup-managed-caller", {
              script: callerScript,
              env: { SITEKEY: Cloudflare.Turnstile.Widget.lookup({ sitekey }).sitekey },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
