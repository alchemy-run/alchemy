import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { getIspCustomer, logLevel, tags, untilGone, untilObserved } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  customerName: string;
  contactName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus",
    });
    const customer = yield* Azure.ConnectedCache.IspCustomer("Customer", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      // Connected Cache for ISPs exists only in westus, northeurope, koreacentral.
      location: "westus",
      customerName: props.customerName,
      contactName: props.contactName,
      contactEmail: "mcc-isp-test@example.com",
      tags: props.tags,
    });
    return { group, customer };
  });

// Cost: the ARM ISP customer resource is free. ~2-4 minutes.
test.provider(
  "create, update, replace, and delete a Connected Cache ISP customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, customer } = yield* stack.deploy(
        program({
          customerName: "Alchemy ISP",
          contactName: "Alchemy Test",
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      expect(customer.tags).toEqual({ env: "test" });
      expect(customer.customerName).toEqual("Alchemy ISP");
      expect(customer.contactName).toEqual("Alchemy Test");
      expect(customer.signupStatus).toEqual(false);
      expect(customer.customerId).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getIspCustomer(rg, customer.customerResourceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.customer?.contactEmail).toEqual("mcc-isp-test@example.com");
      expect(observed.tags?.["alchemy::id"]).toEqual("Customer");
      expect(observed.tags?.env).toEqual("test");

      // In-place update: contact name and tags.
      const updated = yield* stack.deploy(
        program({ customerName: "Alchemy ISP", contactName: "Alchemy Ops", tags: { env: "prod" } }),
      );
      expect(updated.customer.customerResourceName).toEqual(customer.customerResourceName);
      expect(updated.customer.customerId).toEqual(customer.customerId);
      const afterUpdate = yield* untilObserved(
        getIspCustomer(rg, customer.customerResourceName),
        (c) => c.properties?.customer?.contactName === "Alchemy Ops",
      );
      expect(afterUpdate.tags?.env).toEqual("prod");
      expect(afterUpdate.properties?.customer?.contactName).toEqual("Alchemy Ops");

      // Replacement: the display name is create-only.
      const redisplayed = yield* stack.deploy(
        program({
          customerName: "Alchemy ISP Ops",
          contactName: "Alchemy Ops",
          tags: { env: "prod" },
        }),
      );
      expect(redisplayed.customer.customerResourceName).not.toEqual(customer.customerResourceName);
      expect(redisplayed.customer.customerName).toEqual("Alchemy ISP Ops");
      const redisplayedGone = yield* untilGone(getIspCustomer(rg, customer.customerResourceName));
      expect(redisplayedGone).toEqual("gone");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-mcc-isp-renamed",
          customerName: "Alchemy ISP Ops",
          contactName: "Alchemy Ops",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.customer.customerResourceName).toEqual("alchemy-test-mcc-isp-renamed");
      const renamed = yield* getIspCustomer(rg, "alchemy-test-mcc-isp-renamed");
      expect(renamed.tags?.env).toEqual("prod");
      const oldGone = yield* untilGone(
        getIspCustomer(rg, redisplayed.customer.customerResourceName),
      );
      expect(oldGone).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      const renamedGone = yield* untilGone(getIspCustomer(rg, "alchemy-test-mcc-isp-renamed"));
      expect(renamedGone).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
