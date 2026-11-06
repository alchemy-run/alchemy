import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as resourceSharing from "@distilled.cloud/cloudflare/resource-sharing";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:resourcesharing", "live"];

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

// Creating a share needs a recipient account and Resource Sharing Edit on the
// token (Share.test.ts gates its lifecycle the same way). Reading shares
// works on any account.
const recipientAccountId = process.env.CLOUDFLARE_TEST_SHARE_RECIPIENT_ACCOUNT_ID;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ShareLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const policy = yield* Cloudflare.Gateway.Rule("lookup-target-policy", {
      action: "block",
      traffic: 'dns.fqdn == "share-lookup.alchemy-test.example"',
      filters: ["dns"],
      enabled: false,
    });
    const share = yield* Cloudflare.ResourceSharing.Share("lookup-target", {
      recipients: [{ accountId: recipientAccountId! }],
      resources: [{ resourceType: "gateway-policy", resourceId: policy.ruleId }],
    });
    return { shareId: share.shareId.as<string>(), name: share.name.as<string>() };
  }),
);

const target = beforeAll(
  recipientAccountId ? deploy(TargetStack) : Effect.succeed({ shareId: "", name: "" }),
);
afterAll.skipIf(!recipientAccountId || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!recipientAccountId)(
  "a looked-up share resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { shareId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.ResourceSharing.Share.lookup({ name });
        const byId = Cloudflare.ResourceSharing.Share.lookup({ shareId });
        yield* Cloudflare.Worker("share-lookup-caller", {
          script: callerScript,
          env: { REF: byName.shareId },
        });
        return { byNameId: byName.shareId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byNameId).toBe(shareId);
      expect(out.byIdName).toBe(name);

      const plan = yield* stack.plan(program);
      expect(plan.resources["share-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const survivor = yield* resourceSharing.getResourceSharing({ accountId, shareId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing share fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-share-by-name": Cloudflare.ResourceSharing.Share.lookup({ name }).shareId,
        "missing-share-by-id": Cloudflare.ResourceSharing.Share.lookup({
          shareId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }).shareId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { REF: value } })),
          ["LookupNotFoundError"],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
