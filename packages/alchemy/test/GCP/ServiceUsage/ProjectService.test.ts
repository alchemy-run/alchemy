import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as serviceusage from "@distilled.cloud/gcp/serviceusage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: GCP.providers() });

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test.provider.skipIf(!hasGcpCreds)(
  "adopts and preserves an enabled project service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const enabled = yield* stack.deploy(
        GCP.ServiceUsage.ProjectService("ServiceUsageApi", {
          service: "serviceusage.googleapis.com",
          disableOnDestroy: false,
        }),
      );

      expect(enabled.project).toEqual(process.env.GOOGLE_PROJECT_ID);
      expect(enabled.service).toEqual("serviceusage.googleapis.com");
      expect(enabled.state).toEqual("ENABLED");

      const fetched = yield* serviceusage.getServices({
        name: `projects/${enabled.project}/services/${enabled.service}`,
      });
      expect(fetched.state).toEqual("ENABLED");

      yield* stack.destroy();

      const preserved = yield* serviceusage.getServices({
        name: `projects/${enabled.project}/services/${enabled.service}`,
      });
      expect(preserved.state).toEqual("ENABLED");
    }),
  { timeout: 120_000 },
);
