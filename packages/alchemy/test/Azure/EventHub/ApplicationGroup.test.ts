import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
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
    // Application groups need a Premium (or Dedicated) namespace.
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Premium",
      capacity: 1,
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

// Premium namespace, 1 PU (~$1.23/hour, billed per started hour): ~$1.25
// per run, 5-10 minutes to provision.
test.provider.skipIf(!runExpensive)(
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

// Premium namespace, 1 PU (~$1.25 per run). Needs the distilled patch
// patches/eventhub/ApplicationGroupCreateOrUpdateApplicationGroup.json
// regenerated (the generated policy schema strips rateLimitThreshold and
// metricId).
test.provider.skipIf(!runExpensive)(
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

// Ungated probe: a Standard namespace (~$0.03/hour, a few minutes) rejects
// application groups with the typed tier error, which the provider treats
// as "absent" on read and delete.
test.provider(
  "a Standard namespace rejects application groups with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const namespace = yield* Azure.EventHub.Namespace("Events", {
            resourceGroup: group.resourceGroupName,
            sku: "Standard",
          });
          return { group, namespace };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* eventhub
        .ApplicationGroupCreateOrUpdateApplicationGroup({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          namespaceName: namespace.namespaceName,
          applicationGroupName: "probe",
          properties: { clientAppGroupIdentifier: "SASKeyName=probe" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("EventHubApplicationGroupNotSupported");
      const getError = yield* eventhub
        .GetApplicationGroup({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          namespaceName: namespace.namespaceName,
          applicationGroupName: "probe",
        })
        .pipe(Effect.flip);
      expect(getError._tag).toEqual("EventHubApplicationGroupNotSupported");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
