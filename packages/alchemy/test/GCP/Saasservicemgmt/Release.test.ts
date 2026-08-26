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

const blueprintPackage = `${location}-docker.pkg.dev/${project}/blueprints/store:v1`;

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsReleases on a missing release fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsReleases({
          name: `projects/${project}/locations/${location}/releases/alchemy-missing-rel`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a release",
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
          });
          const release = yield* GCP.Saasservicemgmt.Release("V1", {
            location,
            unitKind: kind.name,
            blueprint: { package: blueprintPackage },
            labels: { env: "test" },
          });
          return { product, kind, release };
        }),
      );

      expect(created.release.name).toContain("/releases/");
      expect(created.release.unitKindId).toEqual(created.kind.unitKindId);
      expect(created.release.blueprint?.package).toEqual(blueprintPackage);
      expect(created.release.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsReleases({
        name: created.release.name,
      });
      expect(fetched.name).toEqual(created.release.name);
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
          });
          const release = yield* GCP.Saasservicemgmt.Release("V1", {
            releaseId: created.release.releaseId,
            location,
            unitKind: kind.name,
            blueprint: { package: blueprintPackage },
            inputVariableDefaults: [
              { variable: "region", type: "STRING", value: location },
            ],
            labels: { env: "prod" },
          });
          return { product, kind, release };
        }),
      );

      expect(updated.release.name).toEqual(created.release.name);
      expect(updated.release.labels).toMatchObject({ env: "prod" });
      expect(updated.release.inputVariableDefaults[0]?.variable).toEqual(
        "region",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsReleases({
          name: created.release.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
