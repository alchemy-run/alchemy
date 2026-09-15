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
          name: "nodes/0/deployments/0/devices/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createNodesDeploymentsDevices is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createNodesDeploymentsDevices({
          parent: "nodes/0/deployments/0",
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
          const node = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "device-parent",
          });
          const site = yield* GCP.ProdTtSasportal.CustomersNodesDeployment(
            "Site",
            {
              node: node.name,
              displayName: "yard",
            },
          );
          return yield* GCP.ProdTtSasportal.NodesDeploymentsDevice("Cbsd", {
            deployment: site.name,
            displayName: "yard-ap",
            fccId: "TESTFCCID",
            serialNumber: "ALCHEMY-ND-1",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(created.name).toContain("/devices/");
      expect(created.displayName).toEqual("yard-ap");
      expect(created.fccId).toEqual("TESTFCCID");

      const fetched = yield* sas.getDeploymentsDevices({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const node = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "device-parent",
          });
          const site = yield* GCP.ProdTtSasportal.CustomersNodesDeployment(
            "Site",
            {
              node: node.name,
              displayName: "yard",
            },
          );
          return yield* GCP.ProdTtSasportal.NodesDeploymentsDevice("Cbsd", {
            deployment: site.name,
            name: created.name,
            fccId: created.fccId,
            serialNumber: created.serialNumber,
            displayName: "yard-ap-2",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("yard-ap-2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getDeploymentsDevices({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
