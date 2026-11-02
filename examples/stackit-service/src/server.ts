import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** The port the program listens on, and the only one opened to the internet. */
export const PORT = 3000;

/** The newest public Ubuntu image of the region, resolved at plan. */
const ubuntuImage = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    return items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
  }).pipe(Effect.orDie),
);

/**
 * One server with a public address and its port open. A Service opens nothing itself.
 * The Server Agent is how Alchemy reaches the server, so no SSH is opened.
 */
export const Box = Effect.gen(function* () {
  const network = yield* Stackit.IaaS.Network("App", {
    ipv4: { prefix: "10.0.1.0/24" },
  });
  const group = yield* Stackit.IaaS.SecurityGroup("WebGroup", {});
  yield* Stackit.IaaS.SecurityGroupRule("Http", {
    securityGroupId: group.securityGroupId,
    direction: "ingress",
    protocol: "tcp",
    portRange: { min: PORT, max: PORT },
  });
  yield* Stackit.IaaS.SecurityGroupRule("Egress", {
    securityGroupId: group.securityGroupId,
    direction: "egress",
  });
  const nic = yield* Stackit.IaaS.NetworkInterface("WebNic", {
    networkId: network.networkId,
    securityGroups: [group.securityGroupId],
  });
  const server = yield* Stackit.IaaS.Server("Box", {
    machineType: "g1.1",
    bootVolume: {
      size: 10,
      source: { type: "image", id: ubuntuImage },
      deleteOnTermination: true,
    },
    networking: { networkInterfaceIds: [nic.networkInterfaceId] },
    agent: { provisioned: true },
  });
  const address = yield* Stackit.IaaS.PublicIp("Address", {
    networkInterfaceId: nic.networkInterfaceId,
  });
  return { server, address };
});
