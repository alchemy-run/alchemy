import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { subscription, untilGone } from "./network.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The DNS resolver API rejects resource group names over 80 characters.
const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: "alchemy-test-dnsresolver-policy",
      location: "eastus",
    });
    const policy = yield* Azure.DnsResolver.Policy("Policy", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, policy };
  });

const getPolicy = (resourceGroupName: string, dnsResolverPolicyName: string) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetDnsResolverPolicy({
      subscriptionId,
      resourceGroupName,
      dnsResolverPolicyName,
    }),
  );

// Cost: a DNS security policy with no virtual network links is free. ~2 min.
test.provider(
  "create, update tags, replace, and delete a DNS security policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, policy } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(policy.tags).toEqual({ env: "test" });
      const observed = yield* getPolicy(rg, policy.policyName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Policy");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.policy.policyName).toEqual(policy.policyName);
      expect((yield* getPolicy(rg, policy.policyName)).tags?.env).toEqual(
        "prod",
      );

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-test-policy-renamed", tags: { env: "prod" } }),
      );
      expect(replaced.policy.policyName).toEqual("alchemy-test-policy-renamed");
      const renamed = yield* getPolicy(rg, "alchemy-test-policy-renamed");
      expect(renamed.tags?.env).toEqual("prod");
      expect(yield* untilGone(getPolicy(rg, policy.policyName))).toEqual(
        "gone",
      );

      // Delete.
      yield* stack.destroy();
      expect(
        yield* untilGone(getPolicy(rg, "alchemy-test-policy-renamed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
