import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { Retry } from "@distilled.cloud/azure";
import * as powerbi from "@distilled.cloud/azure/powerbiprivatelinks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, azureResourceName: string) =>
  Effect.gen(function* () {
    const found = yield* powerbi.ListPowerBIResourceByResourceName({
      subscriptionId: yield* subscription,
      resourceGroupName,
      azureResourceName,
    });
    const service = found[0];
    if (service === undefined) {
      return yield* Effect.die(`no service ${azureResourceName}`);
    }
    return service;
  });

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.PowerBI.PrivateLinkService("Tenant", {
      resourceGroup: group.resourceGroupName,
      tags: props.tags,
    });
    return { group, service };
  });

// The resource itself is free, but the Power BI resource provider answers
// every request with 502 Bad Gateway until a Power BI / Fabric tenant admin
// enables Azure Private Link (Pro/Premium licensing). Runs only on such a
// tenant (AZURE_TEST_PAID=1); a few seconds, ~$0. Do NOT set
// AZURE_TEST_PAID=1 on a tenant without it: the failed PUT leaves an ARM
// record whose delete the RP refuses (403 BadRequest), so the resource group
// stays blocked with ResourceGroupDeletionBlocked.
// Skipped: failed in the last live run. BadGateway: Private link service creation or update is
// forbidden. Operation can only be performed by tenant administrator.
test.provider.skip(
  "create, update, and delete a Power BI private link service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(service.location).toEqual("global");
      const env = yield* Azure.AzureEnvironment.current;
      expect(service.tenantId).toEqual(env.tenantId);
      const observed = yield* getService(
        group.resourceGroupName,
        service.privateLinkServiceName,
      );
      expect(observed.properties?.tenantId).toEqual(env.tenantId);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Tenant");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.service.privateLinkServiceId).toEqual(
        service.privateLinkServiceId,
      );
      expect(updated.service.tags).toEqual({ env: "prod" });
      const reobserved = yield* getService(
        group.resourceGroupName,
        service.privateLinkServiceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(group.resourceGroupName, service.privateLinkServiceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe (no resources, $0): on a tenant without Power BI Private
// Link the resource provider answers even the subscription-wide list with
// 502 Bad Gateway. Skipped on a tenant that has it enabled.
test.provider.skipIf(runPaidOnly)(
  "the Power BI resource provider rejects a tenant without Private Link",
  () =>
    Effect.gen(function* () {
      const error = yield* powerbi
        .ListPrivateLinkServicesForPowerBIBySubscriptionId({
          subscriptionId: yield* subscription,
        })
        .pipe(Retry.none, Effect.flip);
      expect(error._tag).toEqual("BadGateway");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
