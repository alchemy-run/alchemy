import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, MACHINE_TYPE, PRESENT, slow, ubuntuImageId } from "./compute.ts";

const { test } = makeStackitTest();

// Needs a running server (g1.1 about EUR 0.02-0.03/h; this suite holds one
// for about 8 minutes, < EUR 0.01 per run): gated behind STACKIT_TEST_SLOW.
const options = { tags: stackitTags("iaas", "volumeattachment"), timeout: 1_800_000 } as const;

const attachmentPresence = (
  projectId: string,
  region: string,
  serverId: string,
  volumeId: string,
) =>
  iaas.getAttachedVolume({ projectId, region, serverId, volumeId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

const attachmentStack = (imageId: string, region: string, deleteOnTermination: boolean) =>
  Effect.gen(function* () {
    const zone = `${region}-1`;
    const network = yield* Stackit.IaaS.Network("AttachNetwork", {
      ipv4: { prefix: "10.231.41.0/24" },
    });
    const server = yield* Stackit.IaaS.Server("AttachServer", {
      machineType: MACHINE_TYPE,
      availabilityZone: zone,
      bootVolume: { size: 10, source: { type: "image", id: imageId } },
      networking: { networkId: network.networkId },
    });
    const volume = yield* Stackit.IaaS.Volume("AttachVolume", {
      size: 1,
      availabilityZone: zone,
    });
    const attachment = yield* Stackit.IaaS.VolumeAttachment("Attach", {
      serverId: server.serverId,
      volumeId: volume.volumeId,
      deleteOnTermination,
    });
    return { server, volume, attachment };
  });

test.provider.skipIf(slow)(
  "attach a volume, update deleteOnTermination, and detach it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(attachmentStack(imageId, region, false));
      const { serverId } = created.server;
      const { volumeId } = created.volume;
      expect(created.attachment.serverId).toEqual(serverId);
      expect(created.attachment.volumeId).toEqual(volumeId);
      expect(created.attachment.deleteOnTermination).toEqual(false);

      const fetched = yield* iaas.getAttachedVolume({ projectId, region, serverId, volumeId });
      expect(fetched.deleteOnTermination ?? false).toEqual(false);
      const volume = yield* iaas.getVolume({ projectId, region, volumeId });
      expect(volume.serverId).toEqual(serverId);
      expect(volume.status).toEqual("ATTACHED");

      // deleteOnTermination updates in place.
      const updated = yield* stack.deploy(attachmentStack(imageId, region, true));
      expect(updated.attachment.deleteOnTermination).toEqual(true);
      const refetched = yield* iaas.getAttachedVolume({ projectId, region, serverId, volumeId });
      expect(refetched.deleteOnTermination).toEqual(true);

      yield* stack.destroy();
      yield* expectGone(attachmentPresence(projectId, region, serverId, volumeId));
    }).pipe(logLevel),
  options,
);
