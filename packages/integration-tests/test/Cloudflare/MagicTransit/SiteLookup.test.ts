import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

const tags = ["provider:cloudflare", "provider:cloudflare:magictransit", "live"];

// Magic WAN sites need a Magic WAN subscription (Site.test.ts gates its
// lifecycle the same way). Set CLOUDFLARE_TEST_MAGIC_WAN=1 on an entitled
// account.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_WAN;

// The target belongs to another stack, as a lookup's target always should.
// It is declared without props, which must work: every prop is optional.
const TargetStack = Alchemy.Stack(
  "MagicSiteLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const site = yield* Cloudflare.MagicTransit.MagicSite("lookup-target");
    return { siteId: site.siteId.as<string>(), name: site.name.as<string>() };
  }),
);

const target = beforeAll(entitled ? deploy(TargetStack) : Effect.succeed({ siteId: "", name: "" }));
afterAll.skipIf(!entitled || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!entitled)(
  "a looked-up site resolves by id and by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { siteId, name } = yield* target;
      const program = Effect.gen(function* () {
        const byName = Cloudflare.MagicTransit.MagicSite.lookup({ name });
        const byId = Cloudflare.MagicTransit.MagicSite.lookup({ siteId });
        yield* Cloudflare.Worker("site-lookup-caller", {
          script: callerScript,
          env: { REF: byName.siteId },
        });
        return { byNameId: byName.siteId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byNameId).toBe(siteId);
      expect(out.byIdName).toBe(name);
      const plan = yield* stack.plan(program);
      expect(plan.resources["site-lookup-caller"].action).toBe("noop");
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);

test.provider.skipIf(!entitled)(
  "a lookup of a missing site fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("site-lookup-missing", {
            script: callerScript,
            env: { REF: Cloudflare.MagicTransit.MagicSite.lookup({ name }).siteId },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
