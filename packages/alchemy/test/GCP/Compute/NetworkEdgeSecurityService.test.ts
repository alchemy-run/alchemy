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
  hasGcpCreds && !!process.env.GCP_TEST_CLOUD_ARMOR && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const region = "us-central1";

const waitUntilGone = (networkEdgeSecurityService: string) =>
  compute
    .getNetworkEdgeSecurityServices({
      project,
      region,
      networkEdgeSecurityService,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getNetworkEdgeSecurityServices on a missing service fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getNetworkEdgeSecurityServices({
          project,
          region,
          networkEdgeSecurityService: "alchemy-missing-ness",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "probe insertNetworkEdgeSecurityServices entitlement",
  () =>
    Effect.gen(function* () {
      const result = yield* compute
        .insertNetworkEdgeSecurityServices({
          project,
          region,
          body: {
            name: "alchemy-ness-probe",
            description: "alchemy entitlement probe",
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
          .deleteNetworkEdgeSecurityServices({
            project,
            region,
            networkEdgeSecurityService: "alchemy-ness-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a network edge security service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkEdgeSecurityService("EdgeArmor", {
            region,
            description: "regional network armor",
          });
        }),
      );

      expect(created.networkEdgeSecurityServiceName).toEqual(
        expect.any(String),
      );
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("regional network armor");

      const fetched = yield* compute.getNetworkEdgeSecurityServices({
        project: created.project,
        region,
        networkEdgeSecurityService: created.networkEdgeSecurityServiceName,
      });
      expect(fetched.name).toEqual(created.networkEdgeSecurityServiceName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkEdgeSecurityService("EdgeArmor", {
            networkEdgeSecurityServiceName:
              created.networkEdgeSecurityServiceName,
            region,
            description: "updated network armor",
          });
        }),
      );
      expect(updated.description).toEqual("updated network armor");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.networkEdgeSecurityServiceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
