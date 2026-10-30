import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import * as Effect from "effect/Effect";
import { MetastoreApi, hiveService, logLevel, parentOf, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsServices on a missing service fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* parentOf;
      yield* stack.destroy();
      yield* stack.deploy(MetastoreApi);

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsServices({
          name: `${parent}/services/alchemy-missing-service`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);

// A developer-tier service takes 20–40 minutes to provision, so `--fast`
// skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "create, relabel, and delete a metastore service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* MetastoreApi;
          return yield* hiveService({ env: "test" });
        }),
      );
      expect(created.name).toContain("/services/");
      expect(created.tier).toEqual("DEVELOPER");
      expect(created.hiveMetastoreConfig?.version).toEqual("3.1.2");

      const fetched = yield* metastore.getProjectsLocationsServices({ name: created.name });
      expect(fetched.state).toEqual("ACTIVE");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* MetastoreApi;
          return yield* hiveService({ env: "prod", role: "hive" });
        }),
      );
      expect(updated.name).toEqual(created.name);

      const refetched = yield* metastore.getProjectsLocationsServices({ name: created.name });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("hive");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        metastore.getProjectsLocationsServices({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 3_600_000 },
);
