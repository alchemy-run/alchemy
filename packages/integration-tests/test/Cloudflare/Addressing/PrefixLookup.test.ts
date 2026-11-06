import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
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

const tags = ["provider:cloudflare", "provider:cloudflare:addressing", "live"];

// Onboarding a BYOIP prefix is a contract process, so the found-prefix test
// looks up the approved prefix an entitled account names in
// CLOUDFLARE_TEST_BYOIP_PREFIX_ID (Prefix.test.ts uses the same variable).
// Listing prefixes works on any account, so the missing-prefix test always
// runs.
const byoipPrefixId = process.env.CLOUDFLARE_TEST_BYOIP_PREFIX_ID;

test.provider.skipIf(!byoipPrefixId)(
  "a looked-up prefix resolves by id and by CIDR",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const prefixId = byoipPrefixId!;
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const byId = Cloudflare.Addressing.Prefix.lookup({ prefixId });
          return { cidr: byId.cidr };
        }),
      );
      const program = Effect.gen(function* () {
        const byCidr = Cloudflare.Addressing.Prefix.lookup({ cidr: first.cidr });
        yield* Cloudflare.Worker("prefix-lookup-caller", {
          script: callerScript,
          env: { REF: byCidr.prefixId },
        });
        return { prefixId: byCidr.prefixId };
      });
      const out = yield* stack.deploy(program);
      expect(out.prefixId).toBe(prefixId);
      const plan = yield* stack.plan(program);
      expect(plan.resources["prefix-lookup-caller"].action).toBe("noop");
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing prefix fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // TEST-NET-2, which no account can onboard.
      const cidr = "198.51.100.0/24";
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("prefix-lookup-missing", {
            script: callerScript,
            env: { REF: Cloudflare.Addressing.Prefix.lookup({ cidr }).prefixId },
          }),
        ),
        ["LookupNotFoundError", cidr],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
