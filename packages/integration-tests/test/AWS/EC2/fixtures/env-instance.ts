import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";
import { envValues, readEnvValues } from "../../../EnvValues.ts";

export const ENV_PORT = 3000;

/** Docker build context for the container-mode instance. */
export const envContainerContext = path.resolve(import.meta.dirname, "env-container");

/**
 * Public subnet + a security group open on {@link ENV_PORT}, shared by both
 * env instances (yielding the same logical ids returns the same resources).
 */
export const EnvNetwork = Effect.gen(function* () {
  const network = yield* AWS.EC2.Network("Ec2EnvNetwork", {
    cidrBlock: "10.82.0.0/16",
    availabilityZones: 1,
  });
  const securityGroup = yield* AWS.EC2.SecurityGroup("Ec2EnvSg", {
    vpcId: network.vpcId,
    description: "alchemy ec2 env e2e",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: ENV_PORT,
        toPort: ENV_PORT,
        cidrIpv4: "0.0.0.0/0",
        description: "app",
      },
    ],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0", description: "all outbound" }],
  });
  return {
    subnetId: network.publicSubnetIds[0],
    securityGroupIds: [securityGroup.groupId],
  };
});

/** Props both env instances share: one t3.small in the public subnet. */
export const envInstanceProps = Effect.gen(function* () {
  const { subnetId, securityGroupIds } = yield* EnvNetwork;
  return {
    imageId: AWS.EC2.amazonLinux2023(),
    instanceType: "t3.small",
    subnetId,
    securityGroupIds,
    associatePublicIpAddress: true,
    port: ENV_PORT,
    env: envValues,
  };
});

/**
 * Hosted program (systemd `EnvironmentFile` mode) whose `env` holds every
 * case in {@link envValues}. It echoes them as read from `process.env`.
 */
export default class EnvInstance extends AWS.EC2.Instance<EnvInstance>()(
  "Ec2EnvInstance",
  Effect.gen(function* () {
    return { ...(yield* envInstanceProps), main: import.meta.filename };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
        const env = yield* Effect.sync(() => readEnvValues(process.env));
        return yield* HttpServerResponse.json(env);
      }).pipe(Effect.orDie),
    };
  }),
) {}
