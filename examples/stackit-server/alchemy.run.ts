import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** The port the page is served on, and the only one opened to the internet. */
const PORT = 8080;

/** What the page says. */
export const GREETING = "hello from a bare server";

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

/** cloud-init writes the page and starts a web server on first boot. */
const userData = `#cloud-config
write_files:
  - path: /srv/www/index.html
    content: "${GREETING}"
runcmd:
  - [systemd-run, --working-directory=/srv/www, python3, -m, http.server, "${PORT}"]
`;

export default Alchemy.Stack(
  "StackitServerExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network("App", {
      ipv4: { prefix: "10.0.2.0/24" },
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
      userData,
    });
    const address = yield* Stackit.IaaS.PublicIp("Address", {
      networkInterfaceId: nic.networkInterfaceId,
    });

    return {
      url: Output.interpolate`http://${address.ip}:${PORT}`,
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
      networkId: network.networkId,
    };
  }),
);
