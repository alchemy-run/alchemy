import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import * as Effect from "effect/Effect";
import {
  MetastoreApi,
  hiveService,
  location,
  logLevel,
  parentOf,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

/**
 * A federation over a Dataproc Metastore service and the project's BigQuery
 * metastore (at least one backend must be a Dataproc Metastore).
 */
const federation = (labels: Record<string, string>) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    yield* MetastoreApi;
    const service = yield* hiveService({ env: "test" });
    return yield* GCP.Metastore.Federation("Lakehouse", {
      location,
      version: "3.1.2",
      backendMetastores: {
        "1": { name: service.name, metastoreType: "DATAPROC_METASTORE" },
        "2": { name: `projects/${project}`, metastoreType: "BIGQUERY" },
      },
      labels,
    });
  });

test.provider(
  "getProjectsLocationsFederations on a missing federation fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* parentOf;
      yield* stack.destroy();
      yield* stack.deploy(MetastoreApi);

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsFederations({
          name: `${parent}/federations/alchemy-missing-federation`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);

// The federation's Dataproc Metastore backend takes 20–40 minutes to
// provision, so `--fast` skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "create, relabel, and delete a metastore federation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(federation({ env: "test" }));
      expect(created.name).toContain("/federations/");
      expect(created.version).toEqual("3.1.2");

      const fetched = yield* metastore.getProjectsLocationsFederations({ name: created.name });
      expect(fetched.state).toEqual("ACTIVE");
      expect(fetched.backendMetastores?.["1"]?.metastoreType).toEqual("DATAPROC_METASTORE");
      expect(fetched.backendMetastores?.["2"]?.metastoreType).toEqual("BIGQUERY");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(federation({ env: "prod" }));
      expect(updated.name).toEqual(created.name);
      const refetched = yield* metastore.getProjectsLocationsFederations({ name: created.name });
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        metastore.getProjectsLocationsFederations({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:metastore", "live"],
    timeout: 3_600_000,
    exclusive: "gcp:metastore",
  },
);
