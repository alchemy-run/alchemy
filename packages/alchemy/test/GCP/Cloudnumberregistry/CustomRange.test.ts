import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  location,
  logLevel,
  probeRegistryBooks,
  project,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const CIDR = "10.250.0.0/22";

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCustomRanges on a missing range fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cnr.getProjectsLocationsCustomRanges({
          name: `projects/${project}/locations/${location}/customRanges/alchemy-missing-range`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a custom range",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeRegistryBooks();
      if (probe.tag !== "ok") {
        expect([...entitlementTags]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const book = yield* GCP.Cloudnumberregistry.RegistryBook(
            "Inventory",
            {
              location,
              labels: { env: "test" },
            },
          );
          const realm = yield* GCP.Cloudnumberregistry.Realm("Private", {
            location,
            registryBook: book.name,
            trafficType: "PRIVATE",
            managementType: "USER",
            ipVersion: "IPV4",
            labels: { env: "test" },
          });
          const range = yield* GCP.Cloudnumberregistry.CustomRange("OnPrem", {
            location,
            realm: realm.name,
            ipv4CidrRange: CIDR,
            description: "alchemy-test-range",
            labels: { env: "test" },
          });
          return { book, realm, range };
        }),
      );

      expect(created.range.customRangeId).toEqual(expect.any(String));
      expect(created.range.name).toEqual(
        `projects/${project}/locations/${location}/customRanges/${created.range.customRangeId}`,
      );
      expect(created.range.ipv4CidrRange).toEqual(CIDR);
      expect(created.range.description).toEqual("alchemy-test-range");
      expect(created.range.labels).toMatchObject({ env: "test" });

      const fetched = yield* cnr.getProjectsLocationsCustomRanges({
        name: created.range.name,
      });
      expect(fetched.name).toEqual(created.range.name);
      expect(fetched.ipv4CidrRange).toEqual(CIDR);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const book = yield* GCP.Cloudnumberregistry.RegistryBook(
            "Inventory",
            {
              registryBookId: created.book.registryBookId,
              location,
              labels: { env: "test" },
            },
          );
          const realm = yield* GCP.Cloudnumberregistry.Realm("Private", {
            realmId: created.realm.realmId,
            location,
            registryBook: book.name,
            trafficType: "PRIVATE",
            managementType: "USER",
            ipVersion: "IPV4",
            labels: { env: "test" },
          });
          const range = yield* GCP.Cloudnumberregistry.CustomRange("OnPrem", {
            customRangeId: created.range.customRangeId,
            location,
            realm: realm.name,
            ipv4CidrRange: CIDR,
            description: "alchemy-prod-range",
            attributes: [{ key: "site", value: "campus" }],
            labels: { env: "prod", role: "range" },
          });
          return { book, realm, range };
        }),
      );

      expect(updated.range.name).toEqual(created.range.name);
      expect(updated.range.customRangeId).toEqual(created.range.customRangeId);
      expect(updated.range.description).toEqual("alchemy-prod-range");
      expect(updated.range.labels).toMatchObject({
        env: "prod",
        role: "range",
      });

      const refetched = yield* cnr.getProjectsLocationsCustomRanges({
        name: created.range.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-range");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("range");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        cnr.getProjectsLocationsCustomRanges({ name: created.range.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
