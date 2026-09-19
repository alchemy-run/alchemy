import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  firstCustomerName,
  hasGcpCreds,
  logLevel,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getCustomersNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.getCustomersNodes({
          name: "customers/0/nodes/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createCustomersNodes is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createCustomersNodes({
          parent: "customers/0",
          body: { displayName: "alchemy-probe" },
        }),
      );
      expect(["Forbidden", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a customer node",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* firstCustomerName();
      expect(customer).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "north-campus",
          });
        }),
      );

      expect(created.name).toContain("/nodes/");
      expect(created.parent).toEqual(customer);
      expect(created.displayName).toEqual("north-campus");

      const fetched = yield* sas.getCustomersNodes({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: created.parent,
            name: created.name,
            displayName: "south-campus",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("south-campus");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getCustomersNodes({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
