import * as EC2 from "@alchemy.run/aws/EC2";
import {
  DATA_PATH,
  engineEnvironment,
  makeControlPlane,
  mountDataDisk,
  PEER_PORT,
  type ControlPlaneProps,
} from "./internal/ControlPlane.ts";

export { DEFAULT_ENGINE_IMAGE, type ControlPlaneProps } from "./internal/ControlPlane.ts";

/**
 * A Rivet control plane on EC2, as a `Rivet.Cluster` Layer: instances
 * across Availability Zones, each running the engine container from its
 * user data with a data disk of its own, an S3 bucket for the durable copy
 * of every actor's data, and an Application Load Balancer in front.
 * Instances find each other through the bucket and talk on a private port
 * only they can reach. A namespace is created for the stage.
 *
 * Each data disk is its own EBS volume, so it outlives the instance it is
 * attached to: a replaced instance mounts the same disk again. Changing the
 * engine image replaces the instances; `RivetAWS.EcsControlPlane` rolls a
 * new image onto the same instances instead.
 *
 * ### Running a control plane on EC2
 * **Example:** Three instances
 * ```typescript
 * export const Cluster = RivetAWS.Ec2ControlPlane("Rivet");
 * ```
 *
 * **Example:** Larger instances and disks
 * ```typescript
 * export const Cluster = RivetAWS.Ec2ControlPlane("Rivet", {
 *   instances: 5,
 *   instanceType: "m7i.large",
 *   diskSize: 100,
 * });
 * ```
 *
 * @primitive
 */
export const Ec2ControlPlane = (id: string, props: ControlPlaneProps = {}) =>
  makeControlPlane<never>(id, props, {
    imageId: EC2.amazonLinux2023(),
    userData: (boot) => {
      const environment = Object.entries(
        engineEnvironment({ ...boot, advertiseAddress: `$PRIVATE_IP:${PEER_PORT}` }),
      )
        .map(([name, value]) => `  -e ${name}="${value}" \\`)
        .join("\n");
      return `#!/bin/bash
set -euo pipefail
dnf install -y docker
systemctl enable --now docker
${mountDataDisk(boot.volumeId)}
IMDS_TOKEN="$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token)"
PRIVATE_IP="$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)"

docker run -d --name rivet-engine --restart always --network host \\
  -v ${DATA_PATH}:${DATA_PATH} \\
${environment}
  '${boot.image}'
`;
    },
  });
