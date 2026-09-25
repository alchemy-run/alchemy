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
  "getNodesDevices on a missing device fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.getNodesDevices({
          name: "nodes/0/nodes/0/devices/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createNodesNodesDevices is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createNodesNodesDevices({
          parent: "nodes/0/nodes/0",
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
          const campus = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "node-parent",
          });
          const child = yield* GCP.ProdTtSasportal.NodesNode("Building", {
            node: campus.name,
            displayName: "bldg-a",
          });
          return yield* GCP.ProdTtSasportal.NodesNodesDevice("Cbsd", {
            node: child.name,
            displayName: "floor-ap",
            fccId: "TESTFCCID",
            serialNumber: "ALCHEMY-NN-1",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(created.name).toContain("/devices/");
      expect(created.displayName).toEqual("floor-ap");
      expect(created.fccId).toEqual("TESTFCCID");

      const fetched = yield* sas.getNodesDevices({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const campus = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "node-parent",
          });
          const child = yield* GCP.ProdTtSasportal.NodesNode("Building", {
            node: campus.name,
            displayName: "bldg-a",
          });
          return yield* GCP.ProdTtSasportal.NodesNodesDevice("Cbsd", {
            node: child.name,
            name: created.name,
            fccId: created.fccId,
            serialNumber: created.serialNumber,
            displayName: "floor-ap-2",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("floor-ap-2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getNodesDevices({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
