import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle =
  !!process.env.GCP_TEST_COMPUTE_INTERCONNECT && !process.env.FAST;

const waitUntilGone = (interconnect: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getInterconnects({ project, interconnect }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
        }),
      ),
    ),
  );

test.provider(
  "getInterconnects on a missing interconnect fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getInterconnects({
          project,
          interconnect: "alchemy-missing-interconnect",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "probe insertInterconnects entitlement",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const result = yield* compute
        .insertInterconnects({
          project,
          body: {
            name: "alchemy-ix-probe",
            description: "alchemy entitlement probe",
            location: `projects/${project}/global/interconnectLocations/iad-zone1-1`,
            interconnectType: "DEDICATED",
            linkType: "LINK_TYPE_ETHERNET_10G_LR",
            requestedLinkCount: 1,
          },
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteInterconnects({
            project,
            interconnect: "alchemy-ix-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(result.tag);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an interconnect",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Interconnect("Pairing", {
            location: `projects/${project}/global/interconnectLocations/iad-zone1-1`,
            interconnectType: "DEDICATED",
            linkType: "LINK_TYPE_ETHERNET_10G_LR",
            requestedLinkCount: 1,
            description: "dedicated pair",
          });
        }),
      );

      expect(created.interconnectName).toEqual(expect.any(String));
      expect(created.description).toEqual("dedicated pair");
      expect(created.interconnectType).toEqual("DEDICATED");

      const fetched = yield* compute.getInterconnects({
        project: created.project,
        interconnect: created.interconnectName,
      });
      expect(fetched.name).toEqual(created.interconnectName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Interconnect("Pairing", {
            interconnectName: created.interconnectName,
            location: `projects/${project}/global/interconnectLocations/iad-zone1-1`,
            interconnectType: "DEDICATED",
            linkType: "LINK_TYPE_ETHERNET_10G_LR",
            requestedLinkCount: 1,
            description: "updated pair",
          });
        }),
      );
      expect(updated.description).toEqual("updated pair");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.interconnectName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
