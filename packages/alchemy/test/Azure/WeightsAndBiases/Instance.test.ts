import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as wandb from "@distilled.cloud/azure/liftrweightsandbiases";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:weightsandbiases", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** W&B dedicated instances are offered in a few regions only. */
const location = "eastus";

const marketplace = {
  offerDetails: {
    publisherId: "wandb",
    offerId: "wandb-pay-as-you-go",
    planId: "wandb-payg",
    planName: "Pay As You Go",
    termId: "monthly",
    termUnit: "P1M",
  },
};

const user = {
  firstName: "Alchemy",
  lastName: "Test",
  emailAddress: process.env.AZURE_TEST_WANDB_EMAIL ?? "alchemy-test@example.com",
};

const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getInstance = (resourceGroupName: string, instancename: string) =>
  Effect.gen(function* () {
    return yield* wandb.GetInstance({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instancename,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const program = (props: {
  tags: Record<string, string>;
  identity?: "SystemAssigned" | "None";
  subdomain?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const instance = yield* Azure.WeightsAndBiases.Instance("Instance", {
      resourceGroup: group.resourceGroupName,
      location,
      marketplace,
      user,
      subdomain: props.subdomain,
      identity:
        props.identity === undefined ? undefined : { type: props.identity },
      tags: props.tags,
    });
    return { group, instance };
  });

// Subscribes to the W&B pay-as-you-go Marketplace offer and provisions a
// dedicated W&B instance (billed by W&B per seat / usage; a dedicated
// instance is not free — estimate well over $1). Provisioning takes
// ~10-30 minutes. The free trial cannot purchase Marketplace SaaS offers;
// run only with AZURE_TEST_PAID=1 on a subscription that accepted the W&B
// Marketplace terms.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a W&B instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(instance.instanceId).not.toEqual("");
      const observed = yield* getInstance(
        group.resourceGroupName,
        instance.instanceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: tags and managed identity.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod" }, identity: "SystemAssigned" }),
      );
      expect(updated.instance.instanceId).toEqual(instance.instanceId);
      const patched = yield* getInstance(
        group.resourceGroupName,
        instance.instanceName,
      );
      expect(patched.tags?.env).toEqual("prod");
      expect(patched.identity?.type).toEqual("SystemAssigned");

      // Replacement: the subdomain is create-only.
      const replaced = yield* stack.deploy(
        program({
          tags: { env: "prod" },
          identity: "SystemAssigned",
          subdomain: `${instance.instanceName.toLowerCase()}-r`,
        }),
      );
      expect(replaced.instance.instanceName).not.toEqual(
        instance.instanceName,
      );
      expect(
        yield* waitGone(
          getInstance(group.resourceGroupName, instance.instanceName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getInstance(group.resourceGroupName, replaced.instance.instanceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Probe: the free trial rejects the W&B Marketplace purchase before any
// instance is created. Skipped on paid subscriptions, where the purchase
// would succeed.
test.provider.skipIf(runPaidOnly)(
  "free trial rejects the W&B marketplace purchase",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.WeightsAndBiases");
      const error = yield* wandb
        .InstancesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instancename: "alchemy-wandb-probe",
          location,
          properties: {
            marketplace: { subscriptionId, ...marketplace },
            user,
            partnerProperties: {
              region: location,
              subdomain: "alchemy-wandb-probe",
            },
          },
        })
        .pipe(Effect.flip);
      // `ResourceCreationValidateFailed` (Marketplace eligibility check) is
      // shared by every Liftr ISV provider; distilled types it under the
      // Datadog-named class.
      expect(error._tag).toEqual("DatadogMonitorCreationValidateFailed");
      expect(error.message).toContain("MarketplaceValidation");
      expect(
        yield* waitGone(
          getInstance(group.resourceGroupName, "alchemy-wandb-probe"),
        ),
      ).toEqual("gone");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
