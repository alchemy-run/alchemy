import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import * as frontdoor from "@distilled.cloud/azure/frontdoor";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  profileStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  profileName: string,
  securityPolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetSecurityPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      securityPolicyName,
    });
  });

/** Front Door WAF policies are not an Alchemy resource yet: create out of band. */
const ensureWafPolicy = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const policy = yield* frontdoor.PoliciesCreateOrUpdate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      policyName: "alchemycdnwaf",
      location: "Global",
      sku: { name: "Standard_AzureFrontDoor" },
      properties: {
        policySettings: { enabledState: "Enabled", mode: "Detection" },
      },
    });
    return policy.id!;
  });

const program = (props: { wafPolicyId?: string; bothEndpoints: boolean }) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const endpoint = yield* Azure.Cdn.AfdEndpoint("Web", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
    });
    const api = yield* Azure.Cdn.AfdEndpoint("Api", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
    });
    if (props.wafPolicyId === undefined)
      return { group, profile, endpoint, api };
    const policy = yield* Azure.Cdn.SecurityPolicy("Waf", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      wafPolicyId: props.wafPolicyId,
      associations: [
        {
          domainIds: props.bothEndpoints
            ? [endpoint.endpointId, api.endpointId]
            : [endpoint.endpointId],
          patternsToMatch: ["/*"],
        },
      ],
    });
    return { group, profile, endpoint, api, policy };
  });

// Front Door Standard profile + WAF policy (<$0.20 per run, 10-20 minutes
// with the profile delete). Free Trial subscriptions cannot create Front
// Door profiles. The WAF policy lives in the stack's resource group and is
// deleted with it.
test.provider.skipIf(!runPaidOnly)(
  "lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program({ bothEndpoints: false }));
      const wafPolicyId = yield* ensureWafPolicy(base.group.resourceGroupName);

      const { group, profile, endpoint, api, policy } = yield* stack.deploy(
        program({ wafPolicyId, bothEndpoints: false }),
      );
      const get = (name: string) =>
        getPolicy(group.resourceGroupName, profile.profileName, name);
      const observed = yield* get(policy!.securityPolicyName);
      expect(JSON.stringify(observed.properties?.parameters)).toContain(
        endpoint.endpointId.split("/").pop()!,
      );
      expect(JSON.stringify(observed.properties?.parameters)).not.toContain(
        api.endpointId.split("/").pop()!,
      );

      // In place: protect a second endpoint. Front Door Standard/Premium
      // only accepts the "/*" path pattern, so domains are the mutable part.
      const updated = yield* stack.deploy(
        program({ wafPolicyId, bothEndpoints: true }),
      );
      expect(updated.policy!.securityPolicyId).toEqual(
        policy!.securityPolicyId,
      );
      const reobserved = yield* get(policy!.securityPolicyName);
      expect(JSON.stringify(reobserved.properties?.parameters)).toContain(
        api.endpointId.split("/").pop()!,
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(policy!.securityPolicyName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
