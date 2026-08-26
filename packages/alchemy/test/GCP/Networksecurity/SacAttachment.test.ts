import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_SAC;

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsSacAttachments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSacAttachments on a missing attachment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsSacAttachments({
          name: `projects/${project}/locations/us-central1/sacAttachments/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a sac attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const realm = yield* GCP.Networksecurity.SacRealm("Prisma", {
            securityService: "PALO_ALTO_PRISMA_ACCESS",
          });
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            description: "sac hub",
          });
          const gateway = yield* GCP.NetworkConnectivity.Spoke("Gateway", {
            location: "us-central1",
            hub: hub.name,
            gateway: {
              capacity: "CAPACITY_1_GBPS",
              ipRangeReservations: [{ ipRange: "10.20.0.0/23" }],
            },
          });
          const attachment = yield* GCP.Networksecurity.SacAttachment(
            "PrismaLink",
            {
              location: "us-central1",
              sacRealm: realm.name,
              nccGateway: gateway.name,
              labels: { env: "test" },
            },
          );
          return { realm, hub, gateway, attachment };
        }),
      );

      expect(created.attachment.name).toContain("/sacAttachments/");
      expect(created.attachment.location).toEqual("us-central1");
      expect(created.attachment.labels).toMatchObject({ env: "test" });
      expect(created.attachment.sacRealm).toContain(created.realm.sacRealmId);

      const fetched = yield* networksecurity.getProjectsLocationsSacAttachments(
        {
          name: created.attachment.name,
        },
      );
      expect(fetched.name).toEqual(created.attachment.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.attachment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
