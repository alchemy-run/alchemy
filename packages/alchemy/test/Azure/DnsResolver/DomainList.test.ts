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
const program = (props: {
  name?: string;
  domains: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: "alchemy-test-dnsresolver-domainlist",
      location: "eastus",
    });
    const list = yield* Azure.DnsResolver.DomainList("Blocked", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      domains: props.domains,
      tags: props.tags,
    });
    return { group, list };
  });

const getList = (
  resourceGroupName: string,
  dnsResolverDomainListName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    dnsresolver.GetDnsResolverDomainList({
      subscriptionId,
      resourceGroupName,
      dnsResolverDomainListName,
    }),
  );

// Cost: domain lists are free. ~2 min.
test.provider(
  "create, update domains, replace, and delete a DNS resolver domain list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, list } = yield* stack.deploy(
        program({ domains: ["contoso.com."], tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(list.domains).toEqual(["contoso.com."]);
      expect(list.tags).toEqual({ env: "test" });
      const observed = yield* getList(rg, list.domainListName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.domains).toEqual(["contoso.com."]);
      expect(observed.tags?.["alchemy::id"]).toEqual("Blocked");

      // In-place update: domains and tags.
      const updated = yield* stack.deploy(
        program({
          domains: ["contoso.com.", "fabrikam.net."],
          tags: { env: "prod" },
        }),
      );
      expect(updated.list.domainListName).toEqual(list.domainListName);
      const reobserved = yield* getList(rg, list.domainListName);
      expect([...(reobserved.properties?.domains ?? [])].sort()).toEqual([
        "contoso.com.",
        "fabrikam.net.",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-domainlist-renamed",
          domains: ["fabrikam.net."],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.list.domainListName).toEqual(
        "alchemy-test-domainlist-renamed",
      );
      const renamed = yield* getList(rg, "alchemy-test-domainlist-renamed");
      expect(renamed.properties?.domains).toEqual(["fabrikam.net."]);
      expect(yield* untilGone(getList(rg, list.domainListName))).toEqual(
        "gone",
      );

      // Delete.
      yield* stack.destroy();
      expect(
        yield* untilGone(getList(rg, "alchemy-test-domainlist-renamed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dnsresolver", "live"],
    timeout: 600_000,
  },
);
