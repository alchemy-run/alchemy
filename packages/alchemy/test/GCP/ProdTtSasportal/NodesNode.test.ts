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
  "getNodesNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.getNodesNodes({
          name: "nodes/0/nodes/alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createNodesNodes is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createNodesNodes({
          parent: "nodes/0",
          body: { displayName: "alchemy-probe" },
        }),
      );
      expect(["Forbidden", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a nested node",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* firstCustomerName();
      expect(customer).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "node-parent",
          });
          return yield* GCP.ProdTtSasportal.NodesNode("Building", {
            node: parent.name,
            displayName: "bldg-a",
          });
        }),
      );

      expect(created.name).toContain("/nodes/");
      expect(created.displayName).toEqual("bldg-a");

      const fetched = yield* sas.getNodesNodes({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "node-parent",
          });
          return yield* GCP.ProdTtSasportal.NodesNode("Building", {
            node: parent.name,
            name: created.name,
            displayName: "bldg-b",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("bldg-b");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getNodesNodes({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
