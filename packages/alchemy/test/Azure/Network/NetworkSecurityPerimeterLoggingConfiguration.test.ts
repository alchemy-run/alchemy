import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import { ensureFeature } from "../features.ts";
import { runPaidOnly } from "../gates.ts";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

// The Microsoft.Network/EnableServiceTagsInNsp preview feature needs Microsoft
// approval: self-registration stays `Pending` on a pay-as-you-go subscription. The
// lifecycle registers it and runs with AZURE_TEST_PAID=1 and AZURE_TEST_NSP_LOGGING=1
// once approved; otherwise the probe asserts the typed rejection.
const allowListed = !!process.env.AZURE_TEST_NSP_LOGGING;

const getPerimeter = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeter({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
    }),
  );

const getLogging = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
  loggingConfigurationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeterLoggingConfiguration({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
      loggingConfigurationName,
    }),
  );

// Perimeters and their logging configuration are free; without the
// EnableServiceTagsInNsp flag ARM answers SubscriptionFeatureNotRegistered
// ("tenant is not whitelisted").
const program = (categories: string[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const perimeter = yield* Azure.Network.NetworkSecurityPerimeter(
      "Perimeter",
      {
        resourceGroup: group.resourceGroupName,
      },
    );
    const logging =
      yield* Azure.Network.NetworkSecurityPerimeterLoggingConfiguration(
        "Logs",
        {
          resourceGroup: group.resourceGroupName,
          networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
          enabledLogCategories: categories,
        },
      );
    return { group, perimeter, logging };
  });

test.provider.skipIf(!runPaidOnly || !allowListed)(
  "create, update, and delete a perimeter logging configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureFeature("Microsoft.Network", "EnableServiceTagsInNsp");
      yield* stack.destroy();

      const { group, perimeter, logging } = yield* stack.deploy(
        program(["NspPublicInboundPerimeterRulesDenied"]),
      );
      expect(logging.loggingConfigurationName).toEqual("instance");
      expect(logging.enabledLogCategories).toEqual([
        "NspPublicInboundPerimeterRulesDenied",
      ]);

      yield* stack.deploy(
        program([
          "NspPublicInboundPerimeterRulesDenied",
          "NspPublicOutboundPerimeterRulesDenied",
        ]),
      );
      const observed = yield* getLogging(
        group.resourceGroupName,
        perimeter.networkSecurityPerimeterName,
        "instance",
      );
      expect(
        [...(observed.properties?.enabledLogCategories ?? [])].sort(),
      ).toEqual([
        "NspPublicInboundPerimeterRulesDenied",
        "NspPublicOutboundPerimeterRulesDenied",
      ]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPerimeter(
            group.resourceGroupName,
            perimeter.networkSecurityPerimeterName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider.skipIf(allowListed)(
  "perimeter logging is rejected with a typed feature error without the preview feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sub = yield* subscriptionId;
      const { group, perimeter } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: "eastus",
          });
          const perimeter = yield* Azure.Network.NetworkSecurityPerimeter(
            "ProbePerimeter",
            { resourceGroup: group.resourceGroupName },
          );
          return { group, perimeter };
        }),
      );
      const error = yield* network
        .NetworkSecurityPerimeterLoggingConfigurationsCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          networkSecurityPerimeterName: perimeter.networkSecurityPerimeterName,
          loggingConfigurationName: "instance",
          properties: {
            enabledLogCategories: ["NspPublicInboundPerimeterRulesDenied"],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SubscriptionFeatureNotRegistered");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
