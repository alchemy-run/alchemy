import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as domainservices from "@distilled.cloud/azure/domainservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, network, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const DOMAIN_NAME = "aadds-alchemy-test.com";

const getDomainService = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* domainservices.GetDomainService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      domainServiceName: name,
    });
  });

const program = (props: {
  notifyDcAdmins: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* network;
    const domain = yield* Azure.DomainServices.DomainService("Domain", {
      resourceGroup: group.resourceGroupName,
      domainName: DOMAIN_NAME,
      replicaSets: [{ subnetId: subnet.subnetId }],
      sku: "Standard",
      notificationSettings: {
        notifyGlobalAdmins: "Enabled",
        notifyDcAdmins: props.notifyDcAdmins,
      },
      tags: props.tags,
    });
    return { group, subnet, domain };
  });

// Standard managed domain: ~$0.15/hour, but provisioning takes 45-60
// minutes and deletion ~30 (~$0.30 per run, well over the time budget).
// Needs the "Domain Controller Services" service principal in the tenant
// and no other managed domain in the tenant (one per tenant).
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a managed domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, domain } = yield* stack.deploy(
        program({ notifyDcAdmins: "Enabled", tags: { env: "test" } }),
      );
      expect(domain.domainName).toEqual(DOMAIN_NAME);
      expect(
        domain.replicaSets[0]?.domainControllerIpAddresses.length,
      ).toBeGreaterThan(0);
      const observed = yield* getDomainService(
        group.resourceGroupName,
        domain.domainServiceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.notificationSettings?.notifyDcAdmins).toEqual(
        "Enabled",
      );
      expect(observed.tags?.env).toEqual("test");

      // In-place: notification settings and tags.
      const updated = yield* stack.deploy(
        program({ notifyDcAdmins: "Disabled", tags: { env: "prod" } }),
      );
      expect(updated.domain.domainServiceId).toEqual(domain.domainServiceId);
      const reobserved = yield* getDomainService(
        group.resourceGroupName,
        domain.domainServiceName,
      );
      expect(
        reobserved.properties?.notificationSettings?.notifyDcAdmins,
      ).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDomainService(group.resourceGroupName, domain.domainServiceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  // Create (~60 min) + update + delete (~30 min) exceed the usual 15-minute cap.
  { tags, timeout: 7_200_000 },
);

// Ungated probe (free): a missing managed domain surfaces a typed
// not-found, which read and delete rely on to mean "gone".
test.provider(
  "a missing managed domain is a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* getDomainService(
        group.resourceGroupName,
        "alchemy-missing.com",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
