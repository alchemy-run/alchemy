import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  firstCustomerName,
  hasGcpCreds,
  logLevel,
  probeJwt,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getDeploymentsDevices on a missing signed device fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.getDeploymentsDevices({
          name: "nodes/0/deployments/0/devices/alchemy-signed-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_PROD_TT_SASPORTAL)(
  "createSignedNodesDeploymentsDevices is Forbidden without SAS Portal access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sas.createSignedNodesDeploymentsDevices({
          parent: "nodes/0/deployments/0",
          body: {
            encodedDevice: probeJwt,
            installerId: "ALCHEMYCPI",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a signed device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* firstCustomerName();
      expect(customer).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const campus = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "signed-parent",
          });
          const site = yield* GCP.ProdTtSasportal.CustomersNodesDeployment(
            "Site",
            {
              node: campus.name,
              displayName: "signed-site",
            },
          );
          return yield* GCP.ProdTtSasportal.SignedNodesDeploymentsDevice(
            "Cbsd",
            {
              deployment: site.name,
              encodedDevice: probeJwt,
              installerId: "ALCHEMYCPI",
              displayName: "signed-1",
            },
          );
        }),
      );

      expect(created.name).toContain("/devices/");
      expect(created.displayName).toEqual("signed-1");

      const fetched = yield* sas.getDeploymentsDevices({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const campus = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
            customer: customer!,
            displayName: "signed-parent",
          });
          const site = yield* GCP.ProdTtSasportal.CustomersNodesDeployment(
            "Site",
            {
              node: campus.name,
              displayName: "signed-site",
            },
          );
          return yield* GCP.ProdTtSasportal.SignedNodesDeploymentsDevice(
            "Cbsd",
            {
              deployment: site.name,
              name: created.name,
              encodedDevice: probeJwt,
              installerId: "ALCHEMYCPI",
              displayName: "signed-2",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("signed-2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        (name) => sas.getDeploymentsDevices({ name }),
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
