import type * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  CELLD_INTERNAL_PORT,
  CELLD_PUBLIC_PORT,
  DEFAULT_CELLD_IMAGE,
  DEFAULT_CELLD_VERSION,
} from "./CelldCli.ts";
import type { EcsFleetOptions } from "./EcsFleet.ts";
import type {
  SecurityGroupId,
  SecurityGroupRuleData,
} from "../AWS/EC2/SecurityGroup.ts";
import type { Input } from "../Input.ts";

export const makeEcsNodeIngress = (
  callers: Input<SecurityGroupId>,
  management: Input<SecurityGroupId>,
  existingCallers: string[] = [],
): Input<SecurityGroupRuleData[]> => [
  {
    ipProtocol: "tcp",
    fromPort: CELLD_PUBLIC_PORT,
    toPort: CELLD_PUBLIC_PORT,
    referencedGroupId: callers,
    description: "Worker callers",
  },
  ...existingCallers.map((groupId) => ({
    ipProtocol: "tcp",
    fromPort: CELLD_PUBLIC_PORT,
    toPort: CELLD_PUBLIC_PORT,
    referencedGroupId: groupId as SecurityGroupId,
    description: "Existing Worker callers; never attached to nodes",
  })),
  {
    ipProtocol: "tcp",
    fromPort: CELLD_INTERNAL_PORT,
    toPort: CELLD_INTERNAL_PORT,
    referencedGroupId: management,
    description: "Trusted management runner only",
  },
];

export class EcsHostConfigurationError extends Data.TaggedError(
  "Celld.EcsHostConfigurationError",
)<{
  readonly message: string;
}> {}

/** An internet-gateway route alone does not give a Lambda ENI public connectivity. */
export const resolveManagementRouteTables = (options: {
  readonly subnetIds: string[];
  readonly routeTables: ec2.RouteTable[];
  readonly endpoints: ec2.VpcEndpoint[];
  readonly ownedEndpointIds: string[];
}) =>
  Effect.gen(function* () {
    const main = options.routeTables.find((table) =>
      table.Associations?.some((association) => association.Main),
    );
    const required = new Set<`rtb-${string}`>();
    for (const subnetId of options.subnetIds) {
      const table =
        options.routeTables.find((candidate) =>
          candidate.Associations?.some(
            (association) => association.SubnetId === subnetId,
          ),
        ) ?? main;
      if (!table?.RouteTableId?.startsWith("rtb-")) {
        return yield* new EcsHostConfigurationError({
          message: `Cannot resolve the management route table for subnet ${subnetId}.`,
        });
      }
      const endpoint = options.endpoints.find(
        (candidate) =>
          candidate.VpcEndpointType === "Gateway" &&
          (candidate.State === "available" || candidate.State === "pending") &&
          candidate.RouteTableIds?.includes(table.RouteTableId!),
      );
      // Keep our endpoint declared on later plans even after its route exists.
      if (
        endpoint &&
        options.ownedEndpointIds.includes(endpoint.VpcEndpointId!)
      ) {
        required.add(table.RouteTableId as `rtb-${string}`);
      } else if (
        !endpoint &&
        !table.Routes?.some(
          (route) =>
            route.DestinationCidrBlock === "0.0.0.0/0" &&
            route.State === "active" &&
            route.NatGatewayId,
        )
      ) {
        required.add(table.RouteTableId as `rtb-${string}`);
      }
    }
    return [...required].sort();
  });

export interface EcsHostConfiguration {
  readonly runtimeVersion: string;
  readonly image: string;
  readonly capacity: "fargate" | "ec2";
  readonly instanceType?: string;
  readonly containerRuntime?: "runsc";
  readonly runtimeRelease?: string;
  readonly architecture?: "ARM64" | "X86_64";
  readonly reservedMemoryMiB?: number;
  readonly memoryMiB?: number;
  readonly cpuUnits?: number;
}

export const resolveEcsHostConfiguration = (
  options: EcsFleetOptions,
  props: { readonly runtimeVersion?: string; readonly image?: string },
) =>
  Effect.gen(function* () {
    const runtimeVersion = props.runtimeVersion ?? DEFAULT_CELLD_VERSION;
    const image = props.image ?? DEFAULT_CELLD_IMAGE;
    if (
      runtimeVersion !== DEFAULT_CELLD_VERSION ||
      image !== DEFAULT_CELLD_IMAGE
    ) {
      return yield* new EcsHostConfigurationError({
        message:
          "EcsFleet only supports the pinned Celld 0.5.0 runtime image. Binary upgrades require an explicit stopped-fleet maintenance procedure, not an ECS rolling deployment.",
      });
    }
    const capacity = options.capacity?.type ?? "fargate";
    if (capacity === "fargate" && options.containerRuntime !== undefined) {
      return yield* new EcsHostConfigurationError({
        message:
          "Containers and Sandbox require dedicated EC2 capacity; Fargate cannot mount the host Docker socket or install the upstream network fence.",
      });
    }
    if (
      options.capacity?.type === "ec2" &&
      !options.capacity.instanceType.trim()
    ) {
      return yield* new EcsHostConfigurationError({
        message: "EC2 capacity requires an instanceType.",
      });
    }
    return {
      runtimeVersion,
      image,
      capacity,
      ...(options.capacity?.type === "ec2"
        ? { instanceType: options.capacity.instanceType }
        : {}),
      ...(options.containerRuntime
        ? { containerRuntime: options.containerRuntime }
        : {}),
    } satisfies EcsHostConfiguration;
  });

/** Missing configuration identifies fleets created before the split-listener contract. */
export const validateEcsHostTransition = (
  previous: EcsHostConfiguration | undefined,
  next: EcsHostConfiguration,
) =>
  previous === undefined ||
  previous.runtimeVersion !== next.runtimeVersion ||
  previous.image !== next.image ||
  previous.capacity !== next.capacity ||
  previous.instanceType !== next.instanceType ||
  previous.containerRuntime !== next.containerRuntime ||
  previous.runtimeRelease !== next.runtimeRelease ||
  previous.architecture !== next.architecture ||
  previous.reservedMemoryMiB !== next.reservedMemoryMiB ||
  previous.memoryMiB !== next.memoryMiB ||
  previous.cpuUnits !== next.cpuUnits
    ? Effect.fail(
        new EcsHostConfigurationError({
          message:
            "Changing an existing Celld runtime, capacity, or container runtime requires an explicit stopped-fleet maintenance procedure. Legacy fleets without a host configuration cannot be upgraded by a normal deploy.",
        }),
      )
    : Effect.void;

/** ECS credentials remain refreshable through object_store's ambient provider. */
export const makeEcsDockerfile = (
  image: string,
  capacity: "fargate" | "ec2" = "fargate",
) => `
FROM busybox:stable-musl AS tools
FROM ${image}
COPY --from=tools /bin/busybox /alchemy/busybox
COPY <<'ENTRYPOINT_EOF' /alchemy/entrypoint.sh
set -eu
${
  capacity === "ec2"
    ? 'IP="$(/alchemy/busybox cat /var/lib/celld-host/private-ip)"'
    : `META="$(/alchemy/busybox wget -qO- "$ECS_CONTAINER_METADATA_URI_V4")"
IP="$(printf '%s' "$META" | /alchemy/busybox sed -n 's/.*"IPv4Addresses"[[:space:]]*:[[:space:]]*\\[[[:space:]]*"\\([0-9.]*\\)".*/\\1/p' | /alchemy/busybox head -n1)"`
}
case "$IP" in
  10.*|172.16.*|172.17.*|172.18.*|172.19.*|172.2[0-9].*|172.30.*|172.31.*|192.168.*) ;;
  *) echo "ECS metadata did not return a private task IPv4 address" >&2; exit 1 ;;
esac
exec celld --bucket "$CELLD_BUCKET" --listen "0.0.0.0:${CELLD_PUBLIC_PORT}" --internal-listen "$IP:${CELLD_INTERNAL_PORT}" --advertise "$IP:${CELLD_INTERNAL_PORT}"
ENTRYPOINT_EOF
ENTRYPOINT ["/alchemy/busybox", "sh", "/alchemy/entrypoint.sh"]
`;
