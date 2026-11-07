import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as gkehub from "@distilled.cloud/gcp/unstable/gkehub_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { fleetMembership } from "./fixtures/fleet.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  gkehub.getProjectsLocationsMemberships({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

test.provider(
  "getProjectsLocationsMemberships on a missing membership fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkehub.getProjectsLocationsMemberships({
          name: `projects/${project}/locations/global/memberships/alchemy-missing-membership`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 90_000 },
);

// Registering a cluster needs one, which takes about 10 minutes to create,
// so `--fast` skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "register a GKE cluster, relabel the membership, and unregister it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(fleetMembership({ env: "test" }));
      expect(created.name).toContain("/memberships/");
      expect(created.location).toEqual("global");
      expect(created.cluster).toContain("//container.googleapis.com/");
      expect(created.state).toEqual("READY");

      const fetched = yield* gkehub.getProjectsLocationsMemberships({ name: created.name });
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(fleetMembership({ env: "prod" }));
      expect(updated.name).toEqual(created.name);
      const refetched = yield* gkehub.getProjectsLocationsMemberships({ name: created.name });
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 2_700_000 },
);
