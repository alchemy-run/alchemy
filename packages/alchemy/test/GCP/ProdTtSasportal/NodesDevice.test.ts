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
          name: "nodes/0/devices/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createNodesDevices is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createNodesDevices({
          parent: "nodes/0",
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
  "create, update, and delete a node device",
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
          return yield* GCP.ProdTtSasportal.NodesDevice("Cbsd", {
            node: node.name,
            displayName: "lobby-ap",
            fccId: "TESTFCCID",
            serialNumber: "ALCHEMY-NODE-1",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(created.name).toContain("/devices/");
      expect(created.displayName).toEqual("lobby-ap");
      expect(created.fccId).toEqual("TESTFCCID");

      const fetched = yield* sas.getNodesDevices({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const node = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "device-parent",
          });
          return yield* GCP.ProdTtSasportal.NodesDevice("Cbsd", {
            node: node.name,
            name: created.name,
            fccId: created.fccId,
            serialNumber: created.serialNumber,
            displayName: "lobby-ap-2",
            preloadedConfig: {
              category: "DEVICE_CATEGORY_A",
              userId: "alchemy-test",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("lobby-ap-2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getNodesDevices({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
