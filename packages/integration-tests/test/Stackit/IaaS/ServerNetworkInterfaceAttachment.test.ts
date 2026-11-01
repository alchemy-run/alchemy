import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { MACHINE_TYPE, slow, ubuntuImageId } from "./compute.ts";

const { test } = makeStackitTest();

// Needs a running server (g1.1 about EUR 0.02-0.03/h; this suite holds one
// for about 8 minutes, < EUR 0.01 per run): gated behind STACKIT_TEST_SLOW.
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
