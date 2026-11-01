import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, MACHINE_TYPE, PRESENT, slow, ubuntuImageId } from "./compute.ts";

const { test } = makeStackitTest();

// Needs running servers (g1.1 about EUR 0.02-0.03/h; this suite holds three
// for about 8 minutes each, < EUR 0.02 per run): gated behind STACKIT_TEST_SLOW.
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

// Both servers stay deployed across steps, so the move never removes the
// dependency it is moving away from.
const moveStack = (imageId: string, region: string, target: "first" | "second") =>
  Effect.gen(function* () {
    const zone = `${region}-1`;
    const network = yield* Stackit.IaaS.Network("MoveNetwork", {
      ipv4: { prefix: "10.231.44.0/24" },
    });
    const server = (id: string) =>
      Stackit.IaaS.Server(id, {
        machineType: MACHINE_TYPE,
        availabilityZone: zone,
        bootVolume: { size: 10, source: { type: "image", id: imageId } },
        networking: { networkId: network.networkId },
      });
    const first = yield* server("MoveFirst");
    const second = yield* server("MoveSecond");
    const volume = yield* Stackit.IaaS.Volume("MoveVolume", { size: 1, availabilityZone: zone });
    const attachment = yield* Stackit.IaaS.VolumeAttachment("Move", {
      serverId: target === "first" ? first.serverId : second.serverId,
      volumeId: volume.volumeId,
    });
    return { first, second, volume, attachment };
  });

test.provider.skipIf(slow)(
  "move a volume to another server",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(moveStack(imageId, region, "first"));
      const { volumeId } = created.volume;
      expect(created.attachment.serverId).toEqual(created.first.serverId);
      expect((yield* iaas.getVolume({ projectId, region, volumeId })).serverId).toEqual(
        created.first.serverId,
      );

      const moved = yield* stack.deploy(moveStack(imageId, region, "second"));
      expect(moved.volume.volumeId).toEqual(volumeId);
      expect(moved.attachment.serverId).toEqual(moved.second.serverId);
      const volume = yield* iaas.getVolume({ projectId, region, volumeId });
      expect(volume.serverId).toEqual(moved.second.serverId);
      expect(volume.status).toEqual("ATTACHED");
      yield* expectGone(attachmentPresence(projectId, region, moved.first.serverId, volumeId));
      expect(yield* attachmentPresence(projectId, region, moved.second.serverId, volumeId)).toEqual(
        PRESENT,
      );

      yield* stack.destroy();
      yield* expectGone(attachmentPresence(projectId, region, moved.second.serverId, volumeId));
    }).pipe(logLevel),
  options,
);
