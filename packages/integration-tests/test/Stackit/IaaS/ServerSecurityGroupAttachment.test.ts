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
  tags: stackitTags("iaas", "serversecuritygroupattachment"),
  timeout: 1_800_000,
} as const;

const serverGroups = (projectId: string, region: string, serverId: string) =>
  iaas
    .listServerNICs({ projectId, region, serverId })
    .pipe(Effect.map(({ items }) => items.flatMap((nic) => nic.securityGroups ?? [])));

// Both groups stay deployed across steps so the replacement never removes
// the dependency it is moving away from.
const attachStack = (imageId: string, which: "web" | "admin") =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network("SgAttachNetwork", {
      ipv4: { prefix: "10.231.44.0/24" },
    });
    const web = yield* Stackit.IaaS.SecurityGroup("SgAttachWeb", {});
    const admin = yield* Stackit.IaaS.SecurityGroup("SgAttachAdmin", {});
    const server = yield* Stackit.IaaS.Server("SgAttachServer", {
      machineType: MACHINE_TYPE,
      bootVolume: { size: 10, source: { type: "image", id: imageId } },
      networking: { networkId: network.networkId },
    });
    const attachment = yield* Stackit.IaaS.ServerSecurityGroupAttachment("SgAttach", {
      serverId: server.serverId,
      securityGroupId: which === "web" ? web.securityGroupId : admin.securityGroupId,
    });
    return { server, web, admin, attachment };
  });

test.provider.skipIf(slow)(
  "apply a security group to a server, move it, and remove it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(attachStack(imageId, "web"));
      const { serverId } = created.server;
      expect(created.attachment.securityGroupId).toEqual(created.web.securityGroupId);
      const afterAttach = yield* serverGroups(projectId, region, serverId);
      expect(afterAttach).toContain(created.web.securityGroupId);
      expect(afterAttach).not.toContain(created.admin.securityGroupId);

      // A different group replaces the attachment.
      const moved = yield* stack.deploy(attachStack(imageId, "admin"));
      expect(moved.server.serverId).toEqual(serverId);
      const afterMove = yield* serverGroups(projectId, region, serverId);
      expect(afterMove).toContain(moved.admin.securityGroupId);
      expect(afterMove).not.toContain(created.web.securityGroupId);

      yield* stack.destroy();
      const server = yield* iaas.getServer({ projectId, region, serverId }).pipe(
        Effect.as("present" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(server).toEqual("gone");
    }).pipe(logLevel),
  options,
);
