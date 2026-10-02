import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  serviceName: string,
  productId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetProductPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId,
      policyId: "policy",
    }),
  );

const policy = (calls: number) => `<policies>
  <inbound>
    <base />
    <rate-limit calls="${calls}" renewal-period="60" />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>`;

const program = (calls?: number) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const product = yield* Azure.ApiManagement.Product("Starter", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-pp-product",
      displayName: "Product policy test",
      subscriptionRequired: true,
      state: "published",
    });
    const created =
      calls === undefined
        ? undefined
        : yield* Azure.ApiManagement.ProductPolicy("Limits", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            productName: product.productName,
            value: policy(calls),
          });
    return { group, service, product, policy: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "set, update, and delete a product policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(5));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const product = first.product.productName;
      expect(first.policy?.productName).toEqual(product);
      expect((yield* getPolicy(rg, svc, product)).properties?.value).toContain(
        'calls="5"',
      );

      // In-place update of the policy document.
      yield* stack.deploy(program(7));
      expect((yield* getPolicy(rg, svc, product)).properties?.value).toContain(
        'calls="7"',
      );

      // Removing the resource deletes the policy while the product stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getPolicy(rg, svc, product))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
