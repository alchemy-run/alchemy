import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** The port each fixture's program listens on. */
export const EFFECT_PORT = 3000;
export const ASYNC_PORT = 3001;

/** A value that must reach the program and nothing else. */
export const SECRET_VALUE = "stackit-service-secret-b1f3a9";

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
 * One server with a public address and its ports open. `prefix` and `cidr` keep a
 * case's logical ids and network apart; a `labels` change updates the server in place.
 */
export const makeServer = (
  prefix: string,
  cidr: string,
  labels: Record<string, string> = {},
  userData?: string,
) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network(`${prefix}Network`, {
      ipv4: { prefix: cidr },
    });
    const group = yield* Stackit.IaaS.SecurityGroup(`${prefix}Group`, {});
    yield* Stackit.IaaS.SecurityGroupRule(`${prefix}Ingress`, {
      securityGroupId: group.securityGroupId,
      direction: "ingress",
      protocol: "tcp",
      portRange: { min: EFFECT_PORT, max: ASYNC_PORT },
    });
    yield* Stackit.IaaS.SecurityGroupRule(`${prefix}Egress`, {
      securityGroupId: group.securityGroupId,
      direction: "egress",
    });
    const nic = yield* Stackit.IaaS.NetworkInterface(`${prefix}Nic`, {
      networkId: network.networkId,
      securityGroups: [group.securityGroupId],
    });
    const server = yield* Stackit.IaaS.Server(`${prefix}Server`, {
      machineType: "g1.1",
      bootVolume: {
        size: 10,
        source: { type: "image", id: ubuntuImage },
        deleteOnTermination: true,
      },
      networking: { networkInterfaceIds: [nic.networkInterfaceId] },
      agent: { provisioned: true },
      labels,
      ...(userData !== undefined ? { userData } : {}),
    });
    const address = yield* Stackit.IaaS.PublicIp(`${prefix}Address`, {
      networkInterfaceId: nic.networkInterfaceId,
    });
    return { server, address };
  });

/** The server of the effectful fixture, which also has to resolve inside the bundle. */
export const Box = makeServer("StackitServiceEffect", "10.231.91.0/24");

/**
 * The async form, with the handler in `async-service.ts`. The path means nothing
 * inside a deployed bundle, where this module may also be evaluated.
 */
export const makePing = (args: {
  readonly server: Effect.Success<ReturnType<typeof makeServer>>["server"];
  readonly address: Effect.Success<ReturnType<typeof makeServer>>["address"];
  readonly greeting: string;
  /** Logical id, for a second Service on one server. */
  readonly id?: string;
  readonly port?: number;
}) =>
  Stackit.IaaS.Service(args.id ?? "StackitServicePing", {
    server: args.server,
    main: globalThis.__ALCHEMY_RUNTIME__
      ? "async-service.ts"
      : new URL("./async-service.ts", import.meta.url).href,
    port: args.port ?? ASYNC_PORT,
    publicIp: args.address.ip,
    env: { GREETING: args.greeting, SECRET: SECRET_VALUE },
  });

export type PingEnv = Stackit.InferEnv<ReturnType<typeof makePing>>;
