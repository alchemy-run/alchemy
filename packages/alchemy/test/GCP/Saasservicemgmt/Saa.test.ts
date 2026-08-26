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
  "getProjectsLocationsSaas on a missing saas fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsSaas({
          name: `projects/${project}/locations/${location}/saas/alchemy-missing-saa`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a saas",
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
          return yield* GCP.Saasservicemgmt.Saa("Inventory", {
            location,
            locations: [{ name: location }],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.saasId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/saas/${created.saasId}`,
      );
      expect(created.location).toEqual(location);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* saasservicemgmt.getProjectsLocationsSaas({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Saasservicemgmt.Saa("Inventory", {
            saasId: created.saasId,
            location,
            locations: [{ name: location }, { name: "us-east1" }],
            labels: { env: "prod", role: "saas" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.saasId).toEqual(created.saasId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "saas" });
      expect(updated.locations.map((item) => item.name).sort()).toEqual(
        [location, "us-east1"].sort(),
      );

      const refetched = yield* saasservicemgmt.getProjectsLocationsSaas({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("saas");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsSaas({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
