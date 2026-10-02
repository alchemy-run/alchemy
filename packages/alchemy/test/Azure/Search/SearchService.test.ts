import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as search from "@distilled.cloud/azure/search";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, searchServiceName: string) =>
  Effect.gen(function* () {
    return yield* search.GetService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      searchServiceName,
    });
  });

const program = (
  props: Omit<Azure.Search.SearchServiceProps, "resourceGroup">,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.Search.SearchService("Search", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, service };
  });

// Basic tier (~$0.11/hour, billed per started hour) plus a free-tier
// replacement: ~$0.11 per run, ~3-8 minutes.
test.provider(
  "create, update, replace, and delete a search service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({ sku: "basic", tags: { env: "test" } }),
      );
      expect(service.sku).toEqual("basic");
      expect(service.endpoint).toContain(".search.windows.net");
      expect(service.primaryAdminKey).toBeDefined();
      expect(Redacted.value(service.primaryAdminKey!).length).toBeGreaterThan(
        10,
      );
      expect(service.queryKey).toBeDefined();
      const observed = yield* getService(
        group.resourceGroupName,
        service.searchServiceName,
      );
      expect(observed.sku?.name).toEqual("basic");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Search");

      // In place: tags, IP firewall, and data-plane auth mode.
      const updated = yield* stack.deploy(
        program({
          sku: "basic",
          tags: { env: "updated" },
          ipRules: ["203.0.113.0/24"],
          authMode: "aadOrApiKey",
          aadAuthFailureMode: "http403",
        }),
      );
      expect(updated.service.searchServiceId).toEqual(service.searchServiceId);
      expect(updated.service.tags).toEqual({ env: "updated" });
      const reobserved = yield* getService(
        group.resourceGroupName,
        service.searchServiceName,
      );
      expect(reobserved.tags?.env).toEqual("updated");
      expect(
        reobserved.properties?.networkRuleSet?.ipRules?.map((r) => r.value),
      ).toEqual(["203.0.113.0/24"]);
      expect(
        reobserved.properties?.authOptions?.aadOrApiKey?.aadAuthFailureMode,
      ).toEqual("http403");

      // Replacement: the pricing tier is immutable.
      const replaced = yield* stack.deploy(
        program({ sku: "free", tags: { env: "updated" } }),
      );
      expect(replaced.service.searchServiceName).not.toEqual(
        service.searchServiceName,
      );
      const replacedObserved = yield* getService(
        group.resourceGroupName,
        replaced.service.searchServiceName,
      );
      expect(replacedObserved.sku?.name).toEqual("free");
      expect(
        yield* waitGone(
          getService(group.resourceGroupName, service.searchServiceName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(
            group.resourceGroupName,
            replaced.service.searchServiceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
