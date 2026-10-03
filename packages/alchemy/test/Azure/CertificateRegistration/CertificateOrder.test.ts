import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as certificateregistration from "@distilled.cloud/azure/certificateregistration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getOrder = (resourceGroupName: string, certificateOrderName: string) =>
  Effect.gen(function* () {
    return yield* certificateregistration.GetAppServiceCertificateOrder({
      subscriptionId: yield* subscription,
      resourceGroupName,
      certificateOrderName,
    });
  });

const program = (props: {
  distinguishedName: string;
  autoRenew: boolean;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const order = yield* Azure.CertificateRegistration.CertificateOrder(
      "Order",
      {
        resourceGroup: group.resourceGroupName,
        productType: "StandardDomainValidatedSsl",
        distinguishedName: props.distinguishedName,
        autoRenew: props.autoRenew,
        tags: props.tags,
      },
    );
    return { group, order };
  });

// A real, non-refundable (after the cancellation window) purchase: ~$69.99
// per order, two orders per run because of the replacement step. Free-trial
// subscriptions cannot buy App Service certificates. Needs an upgraded
// subscription and both AZURE_TEST_PAID=1 and AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runPaidOnly || !runExpensive)(
  "create, update, replace, and delete a certificate order",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, order } = yield* stack.deploy(
        program({
          distinguishedName: "CN=alchemy-test-1.example.com",
          autoRenew: true,
          tags: { env: "test" },
        }),
      );
      const get = (name: string) => getOrder(group.resourceGroupName, name);
      expect(order.location.toLowerCase()).toEqual("global");
      const observed = yield* get(order.certificateOrderName);
      expect(observed.properties?.productType).toEqual(
        "StandardDomainValidatedSsl",
      );
      expect(observed.properties?.distinguishedName).toEqual(
        "CN=alchemy-test-1.example.com",
      );
      expect(observed.properties?.autoRenew).toEqual(true);
      expect(observed.tags?.env).toEqual("test");

      // In-place: auto-renew and tags.
      const updated = yield* stack.deploy(
        program({
          distinguishedName: "CN=alchemy-test-1.example.com",
          autoRenew: false,
          tags: { env: "prod" },
        }),
      );
      expect(updated.order.certificateOrderId).toEqual(
        order.certificateOrderId,
      );
      const reobserved = yield* get(order.certificateOrderName);
      expect(reobserved.properties?.autoRenew).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the distinguished name is immutable.
      const replaced = yield* stack.deploy(
        program({
          distinguishedName: "CN=alchemy-test-2.example.com",
          autoRenew: false,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.order.certificateOrderName).not.toEqual(
        order.certificateOrderName,
      );
      const replacedObserved = yield* get(replaced.order.certificateOrderName);
      expect(replacedObserved.properties?.distinguishedName).toEqual(
        "CN=alchemy-test-2.example.com",
      );
      expect(yield* waitGone(get(order.certificateOrderName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.order.certificateOrderName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free: a resource group only): the provider's observation
// path maps a missing order to the typed `ResourceNotFound` tag, and the
// subscription-wide list the provider's `list` uses succeeds.
test.provider(
  "a missing certificate order is reported with a typed not-found error",
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
      const error = yield* getOrder(group.resourceGroupName, "probe").pipe(
        Effect.flip,
      );
      expect(error._tag).toEqual("ResourceNotFound");

      const orders =
        yield* certificateregistration.ListAppServiceCertificateOrders({
          subscriptionId: yield* subscription,
        });
      expect(Array.isArray(orders.value)).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
