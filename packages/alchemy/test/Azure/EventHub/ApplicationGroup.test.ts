import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplicationGroup = (
  resourceGroupName: string,
  namespaceName: string,
  applicationGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* eventhub.GetApplicationGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      applicationGroupName,
    });
  });

const program = (props: {
  rule: "Producers" | "Consumers";
  isEnabled: boolean;
  policies?: Azure.EventHub.ApplicationGroupThrottlingPolicy[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Application groups need a Standard namespace.
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    // Both rules stay deployed across the replacement step.
    const producers = yield* Azure.EventHub.NamespaceAuthorizationRule(
      "Producers",
      {
        resourceGroup: group.resourceGroupName,
        namespace: namespace.namespaceName,
        rights: ["Send"],
      },
    );
    const consumers = yield* Azure.EventHub.NamespaceAuthorizationRule(
      "Consumers",
      {
        resourceGroup: group.resourceGroupName,
        namespace: namespace.namespaceName,
        rights: ["Listen"],
      },
    );
    const rule = props.rule === "Producers" ? producers : consumers;
    const appGroup = yield* Azure.EventHub.ApplicationGroup("AppGroup", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      clientAppGroupIdentifier: Output.interpolate`SASKeyName=${rule.authorizationRuleName}`,
      isEnabled: props.isEnabled,
      policies: props.policies,
    });
    return { group, namespace, rule, appGroup };
  });

// Standard namespace (~$0.03/hour) for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete an application group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, rule, appGroup } = yield* stack.deploy(
        program({ rule: "Producers", isEnabled: true }),
      );
      const get = (name: string) =>
        getApplicationGroup(
          group.resourceGroupName,
          namespace.namespaceName,
          name,
        );
      expect(appGroup.clientAppGroupIdentifier).toEqual(
        `SASKeyName=${rule.authorizationRuleName}`,
      );
      const observed = yield* get(appGroup.applicationGroupName);
      expect(observed.properties?.clientAppGroupIdentifier).toEqual(
        `SASKeyName=${rule.authorizationRuleName}`,
      );
      expect(observed.properties?.isEnabled).toEqual(true);

      // In-place: disable the group.
      const updated = yield* stack.deploy(
        program({ rule: "Producers", isEnabled: false }),
      );
      expect(updated.appGroup.applicationGroupId).toEqual(
        appGroup.applicationGroupId,
      );
      const reobserved = yield* get(appGroup.applicationGroupName);
      expect(reobserved.properties?.isEnabled).toEqual(false);

      // Replacement: the client identifier is immutable.
      const replaced = yield* stack.deploy(
        program({ rule: "Consumers", isEnabled: false }),
      );
      expect(replaced.appGroup.applicationGroupName).not.toEqual(
        appGroup.applicationGroupName,
      );
      const replacedObserved = yield* get(
        replaced.appGroup.applicationGroupName,
      );
      expect(replacedObserved.properties?.clientAppGroupIdentifier).toEqual(
        `SASKeyName=${replaced.rule.authorizationRuleName}`,
      );
      expect(replacedObserved.properties?.isEnabled).toEqual(false);
      expect(yield* waitGone(get(appGroup.applicationGroupName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.appGroup.applicationGroupName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Throttling policies need the distilled patch
// patches/eventhub/ApplicationGroupCreateOrUpdateApplicationGroup.json
// (the generated policy schema strips rateLimitThreshold/metricId) to be
// regenerated. Standard namespace for a few minutes: well under $0.05.
test.provider.skipIf(!process.env.AZURE_TEST_EVENTHUB_APPGROUP_POLICIES)(
  "apply and update throttling policies on an application group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, appGroup } = yield* stack.deploy(
        program({
          rule: "Producers",
          isEnabled: true,
          policies: [
            {
              name: "ingress",
              metricId: "IncomingMessages",
              rateLimitThreshold: 1000,
            },
          ],
        }),
      );
      const get = () =>
        getApplicationGroup(
          group.resourceGroupName,
          namespace.namespaceName,
          appGroup.applicationGroupName,
        );
      const observed = yield* get();
      expect(observed.properties?.policies).toEqual([
        {
          name: "ingress",
          type: "ThrottlingPolicy",
          metricId: "IncomingMessages",
          rateLimitThreshold: 1000,
        },
      ]);

      yield* stack.deploy(
        program({
          rule: "Producers",
          isEnabled: true,
          policies: [
            {
              name: "ingress",
              metricId: "IncomingMessages",
              rateLimitThreshold: 500,
            },
          ],
        }),
      );
      const reobserved = yield* get();
      expect(reobserved.properties?.policies?.[0]).toMatchObject({
        name: "ingress",
        rateLimitThreshold: 500,
      });

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
