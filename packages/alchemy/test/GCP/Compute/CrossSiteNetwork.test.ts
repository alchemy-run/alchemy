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
  hasGcpCreds && !!process.env.GCP_TEST_CROSS_SITE_NETWORK && !process.env.FAST;

const waitUntilGone = (project: string, crossSiteNetwork: string) =>
  compute.getCrossSiteNetworks({ project, crossSiteNetwork }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "probe insertCrossSiteNetworks entitlement",
  () =>
    Effect.gen(function* () {
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertCrossSiteNetworks({
          project,
          body: {
            name: "alchemy-csn-probe",
            description: "alchemy entitlement probe",
          },
        })
        .pipe(
          Effect.map((operation) => ({
            tag: "ok" as const,
            name: operation.name,
          })),
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
        if (result.name) {
          yield* compute
            .deleteCrossSiteNetworks({
              project,
              crossSiteNetwork: "alchemy-csn-probe",
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete a cross-site network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.CrossSiteNetwork("Backbone", {
            description: "cross-cloud fabric",
          });
        }),
      );

      expect(created.crossSiteNetworkName).toEqual(expect.any(String));
      expect(created.description).toEqual("cross-cloud fabric");

      const fetched = yield* compute.getCrossSiteNetworks({
        project: created.project,
        crossSiteNetwork: created.crossSiteNetworkName,
      });
      expect(fetched.name).toEqual(created.crossSiteNetworkName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("cross-cloud fabric");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.CrossSiteNetwork("Backbone", {
            crossSiteNetworkName: created.crossSiteNetworkName,
            description: "updated fabric",
          });
        }),
      );
      expect(updated.crossSiteNetworkName).toEqual(
        created.crossSiteNetworkName,
      );
      expect(updated.description).toEqual("updated fabric");

      const nextName = `r${created.crossSiteNetworkName}`
        .slice(0, 63)
        .replace(/-+$/, "x");
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.CrossSiteNetwork("Backbone", {
            crossSiteNetworkName: nextName,
            description: "replaced fabric",
          });
        }),
      );
      expect(replaced.crossSiteNetworkName).toEqual(nextName);

      const oldGone = yield* waitUntilGone(
        created.project,
        created.crossSiteNetworkName,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        replaced.project,
        replaced.crossSiteNetworkName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
