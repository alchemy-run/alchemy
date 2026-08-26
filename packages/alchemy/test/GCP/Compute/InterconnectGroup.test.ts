import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds &&
  !!process.env.GCP_TEST_COMPUTE_INTERCONNECT &&
  !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (interconnectGroup: string) =>
  compute.getInterconnectGroups({ project, interconnectGroup }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getInterconnectGroups on a missing group fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getInterconnectGroups({
          project,
          interconnectGroup: "alchemy-missing-ixg",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "probe insertInterconnectGroups entitlement",
  () =>
    Effect.gen(function* () {
      const result = yield* compute
        .insertInterconnectGroups({
          project,
          body: {
            name: "alchemy-ixg-probe",
            description: "alchemy entitlement probe",
            intent: { topologyCapability: "NO_SLA" },
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
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteInterconnectGroups({
            project,
            interconnectGroup: "alchemy-ixg-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an interconnect group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InterconnectGroup("Bundle", {
            description: "dev interconnects",
            intent: { topologyCapability: "NO_SLA" },
          });
        }),
      );

      expect(created.interconnectGroupName).toEqual(expect.any(String));
      expect(created.description).toEqual("dev interconnects");

      const fetched = yield* compute.getInterconnectGroups({
        project: created.project,
        interconnectGroup: created.interconnectGroupName,
      });
      expect(fetched.name).toEqual(created.interconnectGroupName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InterconnectGroup("Bundle", {
            interconnectGroupName: created.interconnectGroupName,
            description: "updated interconnects",
            intent: { topologyCapability: "NO_SLA" },
          });
        }),
      );
      expect(updated.description).toEqual("updated interconnects");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.interconnectGroupName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
