import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProvider = (
  resourceGroupName: string,
  securityPartnerProviderName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetSecurityPartnerProvider({
      subscriptionId,
      resourceGroupName,
      securityPartnerProviderName,
    }),
  );

const standalone = (props: {
  securityProviderName: "ZScaler" | "IBoss";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const partner = yield* Azure.Network.SecurityPartnerProvider("Partner", {
      resourceGroup: group.resourceGroupName,
      securityProviderName: props.securityProviderName,
      tags: props.tags,
    });
    return { group, partner };
  });

// A partner provider without a hub is a free ARM object.
test.provider(
  "create, update, replace, and delete a security partner provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, partner } = yield* stack.deploy(
        standalone({ securityProviderName: "ZScaler", tags: { env: "test" } }),
      );
      const observed = yield* getProvider(
        group.resourceGroupName,
        partner.securityPartnerProviderName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.securityProviderName).toEqual("ZScaler");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        standalone({ securityProviderName: "ZScaler", tags: { env: "prod" } }),
      );
      expect(updated.partner.securityPartnerProviderId).toEqual(
        partner.securityPartnerProviderId,
      );
      const reobserved = yield* getProvider(
        group.resourceGroupName,
        partner.securityPartnerProviderName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      const replaced = yield* stack.deploy(
        standalone({ securityProviderName: "IBoss", tags: { env: "prod" } }),
      );
      expect(replaced.partner.securityPartnerProviderName).not.toEqual(
        partner.securityPartnerProviderName,
      );
      expect(replaced.partner.securityProviderName).toEqual("IBoss");
      expect(
        yield* untilGone(
          getProvider(
            group.resourceGroupName,
            partner.securityPartnerProviderName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getProvider(
            group.resourceGroupName,
            replaced.partner.securityPartnerProviderName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Standard virtual hub (~$0.25/hour, 15-30 minutes to provision): run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "attach a security partner provider to a virtual hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, partner, hub } = yield* stack.deploy(
        Effect.gen(function* () {
          const { group, hub } = yield* standardHub;
          const partner = yield* Azure.Network.SecurityPartnerProvider(
            "Partner",
            {
              resourceGroup: group.resourceGroupName,
              securityProviderName: "ZScaler",
              virtualHubId: hub.virtualHubId,
            },
          );
          return { group, hub, partner };
        }),
      );
      expect(partner.virtualHubId?.toLowerCase()).toEqual(
        hub.virtualHubId.toLowerCase(),
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getProvider(
            group.resourceGroupName,
            partner.securityPartnerProviderName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
