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
  "getProjectsLocationsRollouts on a missing rollout fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsRollouts({
          name: `projects/${project}/locations/${location}/rollouts/alchemy-missing-rlo`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a rollout",
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
          });
          const rolloutKind = yield* GCP.Saasservicemgmt.RolloutKind("Wave", {
            location,
            unitKind: kind.name,
            rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
          });
          const rollout = yield* GCP.Saasservicemgmt.Rollout("Wave1", {
            location,
            rolloutKind: rolloutKind.name,
            release: release.name,
            labels: { env: "test" },
          });
          return { product, kind, release, rolloutKind, rollout };
        }),
      );

      expect(created.rollout.name).toContain("/rollouts/");
      expect(created.rollout.releaseId).toEqual(created.release.releaseId);
      expect(created.rollout.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsRollouts({
        name: created.rollout.name,
      });
      expect(fetched.name).toEqual(created.rollout.name);
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
          });
          const rolloutKind = yield* GCP.Saasservicemgmt.RolloutKind("Wave", {
            rolloutKindId: created.rolloutKind.rolloutKindId,
            location,
            unitKind: kind.name,
            rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
          });
          const rollout = yield* GCP.Saasservicemgmt.Rollout("Wave1", {
            rolloutId: created.rollout.rolloutId,
            location,
            rolloutKind: rolloutKind.name,
            release: release.name,
            labels: { env: "prod" },
          });
          return { product, kind, release, rolloutKind, rollout };
        }),
      );

      expect(updated.rollout.name).toEqual(created.rollout.name);
      expect(updated.rollout.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsRollouts({
          name: created.rollout.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
