import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { MACHINE_TYPE, slow, ubuntuImageId } from "./compute.ts";

const { test } = makeStackitTest();

// Needs running servers (g1.1 about EUR 0.02-0.03/h; this suite holds three
// for about 8 minutes each, < EUR 0.02 per run): gated behind STACKIT_TEST_SLOW.
const options = {
  tags: stackitTags("iaas", "servernetworkinterfaceattachment"),
  timeout: 1_800_000,
} as const;

const serverNicIds = (projectId: string, region: string, serverId: string) =>
  iaas
    .listServerNICs({ projectId, region, serverId })
    .pipe(Effect.map(({ items }) => items.map((nic) => nic.id)));

// Both interfaces stay deployed across steps so the replacement never
// removes the dependency it is moving away from.
const attachStack = (imageId: string, which: "first" | "second") =>
  Effect.gen(function* () {
    const front = yield* Stackit.IaaS.Network("NicAttachFront", {
      ipv4: { prefix: "10.231.42.0/24" },
    });
    const back = yield* Stackit.IaaS.Network("NicAttachBack", {
      ipv4: { prefix: "10.231.43.0/24" },
    });
    const server = yield* Stackit.IaaS.Server("NicAttachServer", {
      machineType: MACHINE_TYPE,
      bootVolume: { size: 10, source: { type: "image", id: imageId } },
      networking: { networkId: front.networkId },
    });
    const first = yield* Stackit.IaaS.NetworkInterface("NicAttachFirst", {
      networkId: back.networkId,
    });
    const second = yield* Stackit.IaaS.NetworkInterface("NicAttachSecond", {
      networkId: back.networkId,
    });
    const attachment = yield* Stackit.IaaS.ServerNetworkInterfaceAttachment("NicAttach", {
      serverId: server.serverId,
      networkInterfaceId: which === "first" ? first.networkInterfaceId : second.networkInterfaceId,
    });
    return { server, first, second, attachment };
  });

test.provider.skipIf(slow)(
  "attach a network interface, move the attachment, and detach it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(attachStack(imageId, "first"));
      const { serverId } = created.server;
      expect(created.attachment.networkInterfaceId).toEqual(created.first.networkInterfaceId);
      const afterAttach = yield* serverNicIds(projectId, region, serverId);
      expect(afterAttach).toContain(created.first.networkInterfaceId);
      expect(afterAttach).not.toContain(created.second.networkInterfaceId);

      // A different interface replaces the attachment.
      const moved = yield* stack.deploy(attachStack(imageId, "second"));
      expect(moved.server.serverId).toEqual(serverId);
      expect(moved.attachment.networkInterfaceId).toEqual(moved.second.networkInterfaceId);
      const afterMove = yield* serverNicIds(projectId, region, serverId);
      expect(afterMove).toContain(moved.second.networkInterfaceId);
      expect(afterMove).not.toContain(created.first.networkInterfaceId);

      const nic = yield* iaas.getNic({
        projectId,
        region,
        networkId: moved.second.networkId,
        nicId: moved.second.networkInterfaceId,
      });
      expect(nic.device).toEqual(serverId);

      yield* stack.destroy();
      const server = yield* iaas.getServer({ projectId, region, serverId }).pipe(
        Effect.as("present" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(server).toEqual("gone");
    }).pipe(logLevel),
  options,
);

// Both servers stay deployed across steps, so the move never removes the
// dependency it is moving away from.
const moveStack = (imageId: string, target: "first" | "second") =>
  Effect.gen(function* () {
    const front = yield* Stackit.IaaS.Network("NicMoveFront", {
      ipv4: { prefix: "10.231.45.0/24" },
    });
    const back = yield* Stackit.IaaS.Network("NicMoveBack", {
      ipv4: { prefix: "10.231.46.0/24" },
    });
    const server = (id: string) =>
      Stackit.IaaS.Server(id, {
        machineType: MACHINE_TYPE,
        bootVolume: { size: 10, source: { type: "image", id: imageId } },
        networking: { networkId: front.networkId },
      });
    const first = yield* server("NicMoveFirst");
    const second = yield* server("NicMoveSecond");
    const nic = yield* Stackit.IaaS.NetworkInterface("NicMove", { networkId: back.networkId });
    const attachment = yield* Stackit.IaaS.ServerNetworkInterfaceAttachment("NicMoveAttach", {
      serverId: target === "first" ? first.serverId : second.serverId,
      networkInterfaceId: nic.networkInterfaceId,
    });
    return { first, second, nic, attachment };
  });

test.provider.skipIf(slow)(
  "move a network interface to another server",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(moveStack(imageId, "first"));
      const nicId = created.nic.networkInterfaceId;
      expect(yield* serverNicIds(projectId, region, created.first.serverId)).toContain(nicId);

      const moved = yield* stack.deploy(moveStack(imageId, "second"));
      expect(moved.nic.networkInterfaceId).toEqual(nicId);
      expect(moved.attachment.serverId).toEqual(moved.second.serverId);
      expect(yield* serverNicIds(projectId, region, moved.second.serverId)).toContain(nicId);
      expect(yield* serverNicIds(projectId, region, moved.first.serverId)).not.toContain(nicId);
      const nic = yield* iaas.getNic({
        projectId,
        region,
        networkId: moved.nic.networkId,
        nicId,
      });
      expect(nic.device).toEqual(moved.second.serverId);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
