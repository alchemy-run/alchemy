import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, untilGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const controllerOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const controller = yield* Azure.ServiceNetworking.TrafficController(
    "Controller",
    { resourceGroup: group.resourceGroupName },
  );
  return { group, controller };
});

const getPolicy = (
  resourceGroupName: string,
  trafficControllerName: string,
  securityPolicyName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    servicenetworking.GetSecurityPoliciesInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
      securityPolicyName,
    }),
  );

// --- WAF policies -----------------------------------------------------------

// Both WAF policies stay deployed so the policy can switch between them.
const withWafPolicy = (props: {
  name?: string;
  waf: "A" | "B";
  tags: Record<string, string>;
  attach?: boolean;
}) =>
  Effect.gen(function* () {
    const { group, controller } = yield* controllerOnly;
    const wafA = yield* Azure.Network.WebApplicationFirewallPolicy("WafA", {
      resourceGroup: group.resourceGroupName,
      policySettings: { state: "Enabled", mode: "Detection" },
    });
    const wafB = yield* Azure.Network.WebApplicationFirewallPolicy("WafB", {
      resourceGroup: group.resourceGroupName,
      policySettings: { state: "Enabled", mode: "Prevention" },
    });
    const policy = yield* Azure.ServiceNetworking.SecurityPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      trafficController: controller.trafficControllerName,
      name: props.name,
      wafPolicyId: props.waf === "A" ? wafA.policyId : wafB.policyId,
      tags: props.tags,
    });
    const frontend = props.attach
      ? yield* Azure.ServiceNetworking.Frontend("Frontend", {
          resourceGroup: group.resourceGroupName,
          trafficController: controller.trafficControllerName,
          securityPolicyConfigurations: {
            wafSecurityPolicyId: policy.securityPolicyId,
          },
        })
      : undefined;
    return { group, controller, wafA, wafB, policy, frontend };
  });

// Cost: WAF policies are free until attached; traffic controller
// (~$0.017/hour) + one frontend (~$0.01/hour) + AGC WAF on that frontend
// for a few minutes (< $0.10). ~8-12 minutes.
test.provider(
  "create, update, attach, replace, and delete an AGC WAF security policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, controller, wafA, wafB, policy } = yield* stack.deploy(
        withWafPolicy({ waf: "A", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const tc = controller.trafficControllerName;
      expect(policy.policyType).toEqual("waf");
      expect(policy.wafPolicyId?.toLowerCase()).toEqual(
        wafA.policyId.toLowerCase(),
      );
      const observed = yield* getPolicy(rg, tc, policy.securityPolicyName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Policy");

      // In-place update: WAF policy reference + tags, and attach to a
      // frontend.
      const updated = yield* stack.deploy(
        withWafPolicy({ waf: "B", tags: { env: "prod" }, attach: true }),
      );
      expect(updated.policy.securityPolicyName).toEqual(
        policy.securityPolicyName,
      );
      const reobserved = yield* getPolicy(rg, tc, policy.securityPolicyName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.wafPolicy?.id.toLowerCase()).toEqual(
        wafB.policyId.toLowerCase(),
      );
      expect(
        updated.frontend?.securityPolicyConfigurations.wafSecurityPolicyId?.toLowerCase(),
      ).toEqual(policy.securityPolicyId.toLowerCase());

      // Replacement: an explicit name (the frontend follows the new ID).
      const replaced = yield* stack.deploy(
        withWafPolicy({
          name: "alchemy-test-policy-renamed",
          waf: "B",
          tags: {},
          attach: true,
        }),
      );
      expect(replaced.policy.securityPolicyName).toEqual(
        "alchemy-test-policy-renamed",
      );
      expect(
        replaced.frontend?.securityPolicyConfigurations.wafSecurityPolicyId?.toLowerCase(),
      ).toEqual(replaced.policy.securityPolicyId.toLowerCase());
      expect(
        yield* untilGone(getPolicy(rg, tc, policy.securityPolicyName)),
      ).toEqual("gone");

      // Delete the policy and frontend, keep the controller.
      yield* stack.deploy(controllerOnly);
      expect(
        yield* untilGone(getPolicy(rg, tc, "alchemy-test-policy-renamed")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// --- IP access rule policies ------------------------------------------------

const allowOffice: Azure.ServiceNetworking.SecurityPolicyIpAccessRule = {
  name: "office",
  priority: 100,
  sourceAddressPrefixes: ["203.0.113.0/24"],
  action: "allow",
};
const denyRest: Azure.ServiceNetworking.SecurityPolicyIpAccessRule = {
  name: "everyone-else",
  priority: 500,
  sourceAddressPrefixes: ["*"],
  action: "deny",
};

const withIpPolicy = (props: {
  rules: Azure.ServiceNetworking.SecurityPolicyIpAccessRule[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, controller } = yield* controllerOnly;
    const policy = yield* Azure.ServiceNetworking.SecurityPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      trafficController: controller.trafficControllerName,
      ipAccessRules: props.rules,
      tags: props.tags,
    });
    return { group, controller, policy };
  });

// IP access rule policies are a preview feature that is not enabled on the
// testing subscription: the create is rejected with `AgcIpAccessRulesNotEnabled`.
test.provider(
  "IP access rule policy is rejected without the preview feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, controller } = yield* stack.deploy(controllerOnly);
      const error = yield* servicenetworking
        .SecurityPoliciesInterfaceCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          trafficControllerName: controller.trafficControllerName,
          securityPolicyName: "alchemy-test-ip-probe",
          location: controller.location,
          properties: { ipAccessRulesPolicy: { rules: [allowOffice] } },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AgcIpAccessRulesNotEnabled");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Needs the AGC IP access rules preview feature on the subscription. Free
// policy + traffic controller (~$0.017/hour) for a few minutes. ~6-8 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update rules, and delete an AGC IP access rule security policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, controller, policy } = yield* stack.deploy(
        withIpPolicy({ rules: [allowOffice], tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const tc = controller.trafficControllerName;
      expect(policy.policyType).toEqual("ipAccessRules");
      expect(policy.ipAccessRules).toEqual([allowOffice]);

      const updated = yield* stack.deploy(
        withIpPolicy({ rules: [allowOffice, denyRest], tags: { env: "prod" } }),
      );
      expect(updated.policy.securityPolicyName).toEqual(
        policy.securityPolicyName,
      );
      const observed = yield* getPolicy(rg, tc, policy.securityPolicyName);
      expect(observed.tags?.env).toEqual("prod");
      expect(
        (observed.properties?.ipAccessRulesPolicy?.rules ?? [])
          .map((rule) => rule.name)
          .sort(),
      ).toEqual(["everyone-else", "office"]);

      yield* stack.deploy(controllerOnly);
      expect(
        yield* untilGone(getPolicy(rg, tc, policy.securityPolicyName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
