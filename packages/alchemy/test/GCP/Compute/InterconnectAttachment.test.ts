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
const region = "us-central1";

const waitUntilGone = (interconnectAttachment: string) =>
  compute
    .getInterconnectAttachments({
      project,
      region,
      interconnectAttachment,
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
  "getInterconnectAttachments on a missing attachment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getInterconnectAttachments({
          project,
          region,
          interconnectAttachment: "alchemy-missing-vlan",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "probe insertInterconnectAttachments entitlement",
  () =>
    Effect.gen(function* () {
      const result = yield* compute
        .insertInterconnectAttachments({
          project,
          region,
          body: {
            name: "alchemy-vlan-probe",
            description: "alchemy entitlement probe",
            router: "does-not-exist",
            type: "PARTNER",
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
          .deleteInterconnectAttachments({
            project,
            region,
            interconnectAttachment: "alchemy-vlan-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an interconnect attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const router = yield* GCP.Compute.Router("Edge", {
            region,
            network: network.networkName,
            description: "interconnect router",
          });
          const attachment = yield* GCP.Compute.InterconnectAttachment("Vlan", {
            region,
            router: router.routerName,
            type: "PARTNER",
            description: "partner vlan",
          });
          return { network, router, attachment };
        }),
      );

      expect(created.attachment.interconnectAttachmentName).toEqual(
        expect.any(String),
      );
      expect(created.attachment.region).toEqual(region);
      expect(created.attachment.description).toEqual("partner vlan");

      const fetched = yield* compute.getInterconnectAttachments({
        project: created.attachment.project,
        region,
        interconnectAttachment: created.attachment.interconnectAttachmentName,
      });
      expect(fetched.name).toEqual(
        created.attachment.interconnectAttachmentName,
      );
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const router = yield* GCP.Compute.Router("Edge", {
            routerName: created.router.routerName,
            region,
            network: network.networkName,
            description: "interconnect router",
          });
          return yield* GCP.Compute.InterconnectAttachment("Vlan", {
            interconnectAttachmentName:
              created.attachment.interconnectAttachmentName,
            region,
            router: router.routerName,
            type: "PARTNER",
            description: "updated partner vlan",
            adminEnabled: false,
          });
        }),
      );
      expect(updated.description).toEqual("updated partner vlan");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.attachment.interconnectAttachmentName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
