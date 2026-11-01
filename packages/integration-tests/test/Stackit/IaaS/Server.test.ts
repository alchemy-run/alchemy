import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGone,
  GONE,
  LARGER_MACHINE_TYPE,
  MACHINE_TYPE,
  PRESENT,
  PUBLIC_KEY_1,
  slow,
  ubuntuImageId,
} from "./compute.ts";

const { test } = makeStackitTest();

// Servers are billed per hour by machine type (g1.1/g1.2 about EUR
// 0.02-0.05/h plus a 10 GB boot volume). This suite boots two servers for
// about 15 minutes in total (< EUR 0.05 per run): gated behind
// STACKIT_TEST_SLOW.
const options = { tags: stackitTags("iaas", "server"), timeout: 2_400_000 } as const;

const serverPresence = (projectId: string, region: string, serverId: string) =>
  iaas.getServer({ projectId, region, serverId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

const volumePresence = (projectId: string, region: string, volumeId: string) =>
  iaas.getVolume({ projectId, region, volumeId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

const serverStack = (
  imageId: string,
  props: Partial<Stackit.IaaS.ServerProps> & { machineType: string },
) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network("ServerNetwork", {
      ipv4: { prefix: "10.231.40.0/24" },
    });
    const key = yield* Stackit.IaaS.KeyPair("ServerKey", { publicKey: PUBLIC_KEY_1 });
    const server = yield* Stackit.IaaS.Server("Server", {
      bootVolume: { size: 10, source: { type: "image", id: imageId } },
      networking: { networkId: network.networkId },
      keypairName: key.name,
      ...props,
    });
    return { network, key, server };
  });

test.provider.skipIf(slow)(
  "boot, update, resize, deallocate, replace and delete a server",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      // Create — waits for ACTIVE.
      const created = yield* stack.deploy(
        serverStack(imageId, {
          machineType: MACHINE_TYPE,
          userData: "#cloud-config\nruncmd:\n  - echo first > /tmp/alchemy\n",
          labels: { env: "test" },
          metadata: { purpose: "alchemy-test" },
        }),
      );
      const serverId = created.server.serverId;
      expect(serverId).toEqual(expect.any(String));
      expect(created.server.status).toEqual("ACTIVE");
      expect(created.server.machineType).toEqual(MACHINE_TYPE);
      expect(created.server.keypairName).toEqual(created.key.name);
      expect(created.server.bootVolumeId).toEqual(expect.any(String));
      expect(created.server.networkInterfaces.map((nic) => nic.networkId)).toEqual([
        created.network.networkId,
      ]);

      const fetched = yield* iaas.getServer({ projectId, region, serverId, details: true });
      expect(fetched.status).toEqual("ACTIVE");
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        "alchemy.id": "Server",
        env: "test",
      });

      // Labels and metadata update in place.
      const relabeled = yield* stack.deploy(
        serverStack(imageId, {
          machineType: MACHINE_TYPE,
          userData: "#cloud-config\nruncmd:\n  - echo first > /tmp/alchemy\n",
          labels: { env: "prod" },
          metadata: { purpose: "alchemy-test-2" },
        }),
      );
      expect(relabeled.server.serverId).toEqual(serverId);
      const afterRelabel = yield* iaas.getServer({ projectId, region, serverId });
      expect(Stackit.stripInternalLabels(afterRelabel.labels)).toEqual({ env: "prod" });
      expect(relabeled.server.metadata).toEqual({ purpose: "alchemy-test-2" });

      // A new machine type resizes in place.
      const resized = yield* stack.deploy(
        serverStack(imageId, {
          machineType: LARGER_MACHINE_TYPE,
          userData: "#cloud-config\nruncmd:\n  - echo first > /tmp/alchemy\n",
          labels: { env: "prod" },
          metadata: { purpose: "alchemy-test-2" },
        }),
      );
      expect(resized.server.serverId).toEqual(serverId);
      const afterResize = yield* iaas.getServer({ projectId, region, serverId });
      expect(afterResize.machineType).toEqual(LARGER_MACHINE_TYPE);

      // Power state converges to deallocated.
      const deallocated = yield* stack.deploy(
        serverStack(imageId, {
          machineType: LARGER_MACHINE_TYPE,
          userData: "#cloud-config\nruncmd:\n  - echo first > /tmp/alchemy\n",
          labels: { env: "prod" },
          metadata: { purpose: "alchemy-test-2" },
          desiredStatus: "deallocated",
        }),
      );
      expect(deallocated.server.status).toEqual("DEALLOCATED");
      const afterDeallocate = yield* iaas.getServer({ projectId, region, serverId });
      expect(afterDeallocate.status).toEqual("DEALLOCATED");

      // New user data replaces the server; the old boot volume goes with it.
      const oldBootVolumeId = created.server.bootVolumeId!;
      const replaced = yield* stack.deploy(
        serverStack(imageId, {
          machineType: MACHINE_TYPE,
          userData: "#cloud-config\nruncmd:\n  - echo second > /tmp/alchemy\n",
          labels: { env: "prod" },
        }),
      );
      expect(replaced.server.serverId).not.toEqual(serverId);
      expect(replaced.server.status).toEqual("ACTIVE");
      yield* expectGone(serverPresence(projectId, region, serverId));
      yield* expectGone(volumePresence(projectId, region, oldBootVolumeId));

      yield* stack.destroy();
      yield* expectGone(serverPresence(projectId, region, replaced.server.serverId));
      yield* expectGone(volumePresence(projectId, region, replaced.server.bootVolumeId!));
    }).pipe(logLevel),
  options,
);
