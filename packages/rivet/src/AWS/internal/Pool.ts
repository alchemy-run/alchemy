/**
 * What the AWS pools share: the network their nodes run in.
 *
 * @internal
 */
import * as EC2 from "@alchemy.run/aws/EC2";
import * as SecretsManager from "@alchemy.run/aws/SecretsManager";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ClusterNetwork, ClusterShape } from "../../Cluster.ts";
import { type PoolNodes, SECRET_ENV, splitNodeEnvironment } from "../../internal/PoolHost.ts";

export { nodeEnvironment } from "../../internal/PoolHost.ts";

/** A Secrets Manager secret as an ECS `valueFrom`, pinned to its current version. */
export const valueFrom = (secret: SecretsManager.Secret) =>
  Output.all(secret.secretArn, secret.versionId).pipe(
    Output.map(([arn, version]) => (version ? `${arn}:::${version}` : arn)),
  );

/**
 * An ECS task's view of a pool's nodes: `env` holds the plain values, and
 * `secrets` the `valueFrom` of the control plane's token and of every
 * secret a class reads as config, kept in Secrets Manager. Each is pinned
 * to its version, so a new value rolls the tasks.
 */
export const ecsNodeEnvironment = Effect.fn(function* (id: string, nodes: PoolNodes<unknown>) {
  const split = splitNodeEnvironment(nodes);
  const token = yield* SecretsManager.Secret(`${id}Token`, {
    secretString: split.pipe(Output.map(({ plain }) => Redacted.make(plain.RIVET_TOKEN!))),
  });
  // One secret holds them all; the node loads it into its env at start.
  const classSecrets = yield* SecretsManager.Secret(`${id}SecretEnv`, {
    secretString: split.pipe(Output.map(({ secrets }) => Redacted.make(JSON.stringify(secrets)))),
  });
  return {
    env: split.pipe(Output.map(({ plain: { RIVET_TOKEN: _, ...plain } }) => plain)),
    secrets: Output.all(valueFrom(token), valueFrom(classSecrets)).pipe(
      Output.map(([token, classSecrets]) => ({ RIVET_TOKEN: token, [SECRET_ENV]: classSecrets })),
    ),
  };
});

/** The cluster has no VPC for nodes to join. */
const ownNetwork = { kind: "own" } as const;

export type PoolNetwork = Extract<ClusterNetwork, { kind: "aws" }> | typeof ownNetwork;

/**
 * Nodes join the control plane's VPC when it has one, and a VPC of the
 * pool's own otherwise (Rivet Cloud, or a control plane elsewhere).
 */
export const poolNetworkOf = (cluster: ClusterShape): PoolNetwork =>
  cluster.network?.kind === "aws" ? cluster.network : ownNetwork;

/** The network to run nodes in: the cluster's VPC, or public subnets of the pool's own. */
export const resolvePoolNetwork = Effect.fn(function* (
  id: string,
  network: PoolNetwork,
  cidrBlock: string | undefined,
) {
  if (network.kind === "aws") return network;
  const vpc = yield* EC2.Network(`${id}Network`, {
    cidrBlock: cidrBlock ?? "10.43.0.0/16",
    availabilityZones: 2,
  });
  const group = yield* EC2.SecurityGroup(`${id}NodeGroup`, {
    vpcId: vpc.vpcId,
    description: "Rivet nodes",
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  return {
    kind: "aws" as const,
    vpcId: vpc.vpcId,
    subnetIds: vpc.publicSubnetIds,
    securityGroupId: group.groupId,
  };
});
