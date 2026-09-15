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
  "getDeploymentsDevices on a missing device fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.getDeploymentsDevices({
          name: "customers/0/deployments/0/devices/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createCustomersDeploymentsDevices is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createCustomersDeploymentsDevices({
          parent: "customers/0/deployments/0",
          body: {
            displayName: "alchemy-probe",
            fccId: "TESTFCCID",
            serialNumber: "ALCHEMYPROBE",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a nested device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* firstCustomerName();
      expect(customer).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.ProdTtSasportal.CustomersDeployment(
            "Site",
            {
              customer: customer!,
              displayName: "site",
            },
          );
          return yield* GCP.ProdTtSasportal.CustomersDeploymentsDevice("Cbsd", {
            deployment: parent.name,
            displayName: "rooftop-1",
            fccId: "TESTFCCID",
            serialNumber: "ALCHEMY-DEP-1",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(created.name).toContain("/devices/");
      expect(created.displayName).toEqual("rooftop-1");
      expect(created.fccId).toEqual("TESTFCCID");

      const fetched = yield* sas.getDeploymentsDevices({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.ProdTtSasportal.CustomersDeployment(
            "Site",
            {
              customer: customer!,
              displayName: "site",
            },
          );
          return yield* GCP.ProdTtSasportal.CustomersDeploymentsDevice("Cbsd", {
            deployment: parent.name,
            name: created.name,
            fccId: created.fccId,
            serialNumber: created.serialNumber,
            displayName: "rooftop-2",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("rooftop-2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getDeploymentsDevices({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
