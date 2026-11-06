import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

const tags = ["provider:cloudflare", "provider:cloudflare:dlp", "live"];

// DLP is a paid Zero Trust add-on (Dlp.test.ts pins the `Forbidden` the
// testing account gets). Set CLOUDFLARE_TEST_DLP=1 on an entitled account.
const entitled = !!process.env.CLOUDFLARE_TEST_DLP;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "DlpProfileLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const profile = yield* Cloudflare.Dlp.Profile("lookup-target", {
      entries: [{ name: "employee-id", enabled: true, pattern: { regex: "EMP-[0-9]{6}" } }],
    });
    return { profileId: profile.profileId.as<string>(), name: profile.name.as<string>() };
  }),
);

const target = beforeAll(
  entitled ? deploy(TargetStack) : Effect.succeed({ profileId: "", name: "" }),
);
afterAll.skipIf(!entitled || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!entitled)(
  "a looked-up profile resolves by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { profileId, name } = yield* target;
      const program = Effect.gen(function* () {
        const profile = Cloudflare.Dlp.Profile.lookup({ profileId });
        yield* Cloudflare.Worker("dlp-lookup-caller", {
          script: callerScript,
          env: { REF: profile.profileId },
        });
        return { name: profile.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.name).toBe(name);
      const plan = yield* stack.plan(program);
      expect(plan.resources["dlp-lookup-caller"].action).toBe("noop");
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);

test.provider.skipIf(!entitled)(
  "a lookup of a missing profile fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const profileId = "00000000-0000-4000-8000-000000000000";
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("dlp-lookup-missing", {
            script: callerScript,
            env: { REF: Cloudflare.Dlp.Profile.lookup({ profileId }).profileId },
          }),
        ),
        ["LookupNotFoundError", profileId],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
