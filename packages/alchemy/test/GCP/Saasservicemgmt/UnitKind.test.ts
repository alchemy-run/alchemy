import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  location,
  logLevel,
  probeSaasApi,
  project,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsUnitKinds on a missing unit kind fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsUnitKinds({
          name: `projects/${project}/locations/${location}/unitKinds/alchemy-missing-uk`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a unit kind",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeSaasApi();
      if (probe.tag !== "ok") {
        expect([...entitlementTags]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Saasservicemgmt.Saa("Inventory", {
            location,
            locations: [{ name: location }],
          });
          const kind = yield* GCP.Saasservicemgmt.UnitKind("Store", {
            location,
            saas: product.name,
            labels: { env: "test" },
          });
          return { product, kind };
        }),
      );

      expect(created.kind.name).toContain("/unitKinds/");
      expect(created.kind.saasId).toEqual(created.product.saasId);
      expect(created.kind.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsUnitKinds({
        name: created.kind.name,
      });
      expect(fetched.name).toEqual(created.kind.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Saasservicemgmt.Saa("Inventory", {
            saasId: created.product.saasId,
            location,
            locations: [{ name: location }],
          });
          const kind = yield* GCP.Saasservicemgmt.UnitKind("Store", {
            unitKindId: created.kind.unitKindId,
            location,
            saas: product.name,
            labels: { env: "prod", role: "kind" },
          });
          return { product, kind };
        }),
      );

      expect(updated.kind.name).toEqual(created.kind.name);
      expect(updated.kind.labels).toMatchObject({ env: "prod", role: "kind" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsUnitKinds({
          name: created.kind.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
