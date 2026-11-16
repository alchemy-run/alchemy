import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const KEY = "alchemy-test-project-metadata-item";

const valueOf = (project: string) =>
  compute
    .getProjects({ project })
    .pipe(
      Effect.map(
        (current) => current.commonInstanceMetadata?.items?.find((item) => item.key === KEY)?.value,
      ),
    );

test.provider(
  "set, update, and remove one project metadata key",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        GCP.Compute.ProjectMetadataItem("Item", { key: KEY, value: "one" }),
      );
      expect(created).toEqual({ project, key: KEY, value: "one" });
      expect(yield* valueOf(project)).toEqual("one");

      const updated = yield* stack.deploy(
        GCP.Compute.ProjectMetadataItem("Item", { key: KEY, value: "two" }),
      );
      expect(updated.value).toEqual("two");
      expect(yield* valueOf(project)).toEqual("two");

      yield* stack.destroy();
      expect(yield* valueOf(project)).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
