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

const region = "us-central1";

const waitUntilGone = (project: string, networkAttachment: string) =>
  compute
    .getNetworkAttachments({
      project,
      region,
      networkAttachment,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getNetworkAttachments on a missing attachment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const error = yield* Effect.flip(
        compute.getNetworkAttachments({
          project,
          region,
          networkAttachment: "alchemy-missing-na",
        }),
      );
      expect(error._tag).toBe("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds ||
    !!process.env.FAST ||
    !process.env.GCP_TEST_NETWORK_ATTACHMENT,
)(
  "create, update, and delete a network attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("Consumer", {
            network: network.networkName,
            region,
            ipCidrRange: "10.53.0.0/24",
          });
          const attachment = yield* GCP.Compute.NetworkAttachment("Consumer", {
            region,
            subnetworks: [subnet.selfLink.as<string>()],
            connectionPreference: "ACCEPT_AUTOMATIC",
            description: "psc consumer",
          });
          return { network, subnet, attachment };
        }),
      );

      expect(created.attachment.networkAttachmentName).toEqual(
        expect.any(String),
      );
      expect(created.attachment.region).toEqual(region);
      expect(created.attachment.connectionPreference).toEqual(
        "ACCEPT_AUTOMATIC",
      );
      expect(
        created.attachment.description === "psc consumer" ||
          created.attachment.description === undefined,
      ).toEqual(true);
      expect(created.attachment.subnetworks.length).toBeGreaterThan(0);
      expect(created.attachment.selfLink).toEqual(expect.any(String));

      const fetched = yield* compute.getNetworkAttachments({
        project: created.attachment.project,
        region,
        networkAttachment: created.attachment.networkAttachmentName,
      });
      expect(fetched.name).toEqual(created.attachment.networkAttachmentName);
      expect(fetched.connectionPreference).toEqual("ACCEPT_AUTOMATIC");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("psc consumer");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const subnet = yield* GCP.Compute.Subnetwork("Consumer", {
            subnetworkName: created.subnet.subnetworkName,
            network: network.networkName,
            region,
            ipCidrRange: "10.53.0.0/24",
          });
          return yield* GCP.Compute.NetworkAttachment("Consumer", {
            networkAttachmentName: created.attachment.networkAttachmentName,
            region,
            subnetworks: [subnet.selfLink.as<string>()],
            connectionPreference: "ACCEPT_MANUAL",
            producerAcceptLists: [created.attachment.project],
            description: "psc consumer updated",
          });
        }),
      );

      expect(updated.networkAttachmentName).toEqual(
        created.attachment.networkAttachmentName,
      );
      expect(updated.connectionPreference).toEqual("ACCEPT_MANUAL");
      expect(updated.description).toEqual("psc consumer updated");
      expect(updated.producerAcceptLists).toEqual(
        expect.arrayContaining([created.attachment.project]),
      );

      const fetchedUpdated = yield* compute.getNetworkAttachments({
        project: updated.project,
        region,
        networkAttachment: updated.networkAttachmentName,
      });
      expect(fetchedUpdated.connectionPreference).toEqual("ACCEPT_MANUAL");
      expect(fetchedUpdated.description).toContain("psc consumer updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.attachment.project,
        created.attachment.networkAttachmentName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
