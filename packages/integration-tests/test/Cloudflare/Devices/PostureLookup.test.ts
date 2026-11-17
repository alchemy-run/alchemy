import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:devices", "live"];

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

const osVersion: Cloudflare.Devices.DevicePostureRuleProps = {
  type: "os_version",
  match: [{ platform: "windows" }],
  input: { operatingSystem: "windows", operator: ">=", version: "10.0.19045" },
};

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "DevicePostureLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const rule = yield* Cloudflare.Devices.DevicePostureRule("lookup-target", osVersion);
    return { postureRuleId: rule.postureRuleId.as<string>(), name: rule.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up posture rule gates a new Access policy, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { postureRuleId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Devices.DevicePostureRule.lookup({ name });
        const byId = Cloudflare.Devices.DevicePostureRule.lookup({ postureRuleId });
        const policy = yield* Cloudflare.Access.Policy("posture-lookup-policy", {
          decision: "allow",
          include: [{ everyone: {} }],
          require: [{ devicePosture: byName.postureRuleId }],
        });
        return { policyId: policy.policyId, byIdType: byId.type };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdType).toBe("os_version");

      const live = yield* zeroTrust.getAccessPolicy({ accountId, policyId: out.policyId });
      expect(JSON.stringify(live.require)).toContain(postureRuleId);

      // A lookup re-resolves to the same rule, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["posture-lookup-policy"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the rule alone.
      yield* stack.destroy();
      const survivor = yield* zeroTrust.getDevicePosture({ accountId, ruleId: postureRuleId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing posture rule or integration fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-posture-rule": Cloudflare.Devices.DevicePostureRule.lookup({ name }).postureRuleId,
        "missing-posture-integration": Cloudflare.Devices.DevicePostureIntegration.lookup({ name })
          .integrationId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { REF: value } })),
          ["LookupNotFoundError", name],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a posture rule this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Devices.DevicePostureRule("lookup-managed", osVersion);
      const { postureRuleId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("posture-lookup-managed-caller", {
              script: callerScript,
              env: {
                REF: Cloudflare.Devices.DevicePostureRule.lookup({ postureRuleId }).postureRuleId,
              },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
