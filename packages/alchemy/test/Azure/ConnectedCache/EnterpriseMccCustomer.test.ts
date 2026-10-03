import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  getCustomer,
  logLevel,
  tags,
  untilGone,
  untilSucceeded,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  contactName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const customer = yield* Azure.ConnectedCache.EnterpriseMccCustomer(
      "Customer",
      {
        resourceGroup: group.resourceGroupName,
        name: props.name,
        // Enterprise MCC customers exist only in westus, northeurope, koreacentral.
        location: "westus",
        contactName: props.contactName,
        contactEmail: "mcc-test@example.com",
        tags: props.tags,
      },
    );
    return { group, customer };
  });

// Cost: the ARM customer resource is free. ~1-3 minutes.
test.provider(
  "create, update, replace, and delete a Connected Cache customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, customer } = yield* stack.deploy(
        program({ contactName: "Alchemy Test", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(customer.tags).toEqual({ env: "test" });
      expect(customer.contactName).toEqual("Alchemy Test");
      const observed = yield* untilSucceeded(
        getCustomer(rg, customer.customerResourceName),
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.customer?.contactEmail).toEqual(
        "mcc-test@example.com",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Customer");

      // In-place update: contact name and tags.
      const updated = yield* stack.deploy(
        program({ contactName: "Alchemy Ops", tags: { env: "prod" } }),
      );
      expect(updated.customer.customerResourceName).toEqual(
        customer.customerResourceName,
      );
      const afterUpdate = yield* getCustomer(rg, customer.customerResourceName);
      expect(afterUpdate.tags?.env).toEqual("prod");
      expect(afterUpdate.properties?.customer?.contactName).toEqual(
        "Alchemy Ops",
      );

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-mcc-renamed",
          contactName: "Alchemy Ops",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.customer.customerResourceName).toEqual(
        "alchemy-test-mcc-renamed",
      );
      expect(
        (yield* getCustomer(rg, "alchemy-test-mcc-renamed")).tags?.env,
      ).toEqual("prod");
      expect(
        yield* untilGone(getCustomer(rg, customer.customerResourceName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      expect(
        yield* untilGone(getCustomer(rg, "alchemy-test-mcc-renamed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
