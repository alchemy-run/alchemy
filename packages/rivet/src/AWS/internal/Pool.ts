/**
 * What the AWS pools share: the network their nodes run in.
 *
 * @internal
 */
import * as EC2 from "@alchemy.run/aws/EC2";
import * as SecretsManager from "@alchemy.run/aws/SecretsManager";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ClusterShape } from "../../Cluster.ts";
import { type PoolNodes, SECRET_ENV, splitNodeEnvironment } from "../../internal/PoolHost.ts";
import { Network } from "../Network.ts";

/**
 * Keep each value in a Secrets Manager secret of the pool's own, named
 * `${id}${key}`, and return where each env var reads it from: the
 * secret's ARN pinned to the version deployed, so a new value is a new
 * reference and the nodes restart with it.
 */
export const poolSecrets = Effect.fn(function* (
  id: string,
  values: Record<
    string,
    { readonly key: string; readonly value: Input<Redacted.Redacted<string>> }
  >,
) {
  const refs: Record<string, Output.Output<string>> = {};
  for (const [name, { key, value }] of Object.entries(values)) {
    refs[name] = valueFrom(yield* SecretsManager.Secret(`${id}${key}`, { secretString: value }));
  }
  return refs;
});

/** A Secrets Manager secret as an ECS `valueFrom`, pinned to its current version. */
export const valueFrom = (secret: SecretsManager.Secret) =>
  Output.all(secret.secretArn, secret.versionId).pipe(
    Output.map(([arn, version]) => (version ? `${arn}:::${version}` : arn)),
  );

/**
 * A node's environment for an AWS host that reads secrets from Secrets
 * Manager: `env` without the token or any secret a class reads as config,
 * and `secrets`, where the token and those secrets (as one
 * {@link SECRET_ENV} JSON object, loaded by the node at start) are.
 */
export const secretNodeEnvironment = Effect.fn(function* (id: string, nodes: PoolNodes<unknown>) {
  const split = splitNodeEnvironment(nodes);
  const secrets = yield* poolSecrets(id, {
    RIVET_TOKEN: { key: "Token", value: nodes.environment.RIVET_TOKEN },
    [SECRET_ENV]: {
      key: "SecretEnv",
      value: split.pipe(Output.map(({ secrets }) => Redacted.make(JSON.stringify(secrets)))),
    },
  });
  const env = split.pipe(Output.map(({ plain: { RIVET_TOKEN: _, ...env } }) => env));
  return { env, secrets };
});

/** The cluster has no VPC for nodes to join. */
const ownNetwork = { kind: "own" } as const;

export type PoolNetwork = Network | typeof ownNetwork;

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
  return Network({
    vpcId: vpc.vpcId,
    subnetIds: vpc.publicSubnetIds,
    securityGroupId: group.groupId,
  });
});
