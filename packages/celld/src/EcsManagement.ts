/**
 * The management runner contract of {@link EcsFleet}: deploys reach the
 * nodes' private operator listener through a runner inside the fleet's
 * network, and a separate Layer decides how that runner is hosted. Only the
 * chosen Layer's module — and so only its runner code — is imported.
 */
import type * as EC2 from "@alchemy.run/aws/EC2";
import type * as ECS from "@alchemy.run/aws/ECS";
import type { Input } from "alchemy/Input";
import type { Output } from "alchemy/Output";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { FleetManagementService } from "./Management.ts";

/** Prefix of every queued management object in the fleet bucket. */
export const MANAGEMENT_PREFIX = "alchemy/management/v1";

/** S3 lifecycle rule expiring request objects a lost deployer left behind. */
export const managementRequestsLifecycleRule = {
  ID: "celld-management-requests",
  Status: "Enabled" as const,
  Filter: { Prefix: `${MANAGEMENT_PREFIX}/requests/` },
  Expiration: { Days: 1 },
};

/** How the deployer reaches a queued runner: its queue, and how to start one on demand. */
export interface ManagementQueueState {
  readonly queueUrl: string;
  /** Present for on-demand runners: the deployer starts a task when none is up. */
  readonly launch?: {
    readonly clusterArn: string;
    readonly taskDefinitionArn: string;
    readonly subnetIds: string[];
    readonly securityGroupIds: string[];
  };
}

/** What a fleet hands its management runner to compose. */
export interface EcsManagementFleet {
  readonly id: string;
  readonly tags?: Record<string, string>;
  readonly region: string;
  readonly partition: string;
  readonly bucketName: Output<string>;
  /** Live node sessions the runner requires before it acts. */
  readonly minimumNodes: number;
  readonly cluster: Pick<ECS.Cluster, "clusterArn">;
  readonly vpcId: Input<EC2.VpcId>;
  /** Subnets the nodes run in. */
  readonly subnetIds: Input<EC2.SubnetId[]>;
  /** The management-only security group the nodes admit to their operator listener. */
  readonly securityGroupId: Output<EC2.SecurityGroupId>;
  /** The caller's VPC, when the fleet joins one. */
  readonly vpc?: { readonly vpcId: string; readonly subnetIds: string[] };
  /** The fleet's own network, when it composes one. */
  readonly network?: EC2.Network;
}

/** The runner state a fleet persists on its host state. */
export interface EcsManagementState {
  /** Subnets the runner runs in. */
  readonly managementSubnetIds: Input<EC2.SubnetId[]>;
  readonly managementFunctionArn?: Input<string>;
  readonly managementQueue?: Input<ManagementQueueState>;
}

/**
 * How an {@link EcsFleet} hosts its management runner. Provide one of
 * `Celld.EcsTaskManagement`, `Celld.EcsServiceManagement` or
 * `Celld.EcsLambdaManagement` to the fleet's Layer.
 */
export class EcsManagement extends Context.Service<EcsManagement, EcsManagementService>()(
  "Celld.EcsManagement",
) {}

export interface EcsManagementService {
  /** Compose the runner's resources inside the fleet's namespace. */
  readonly compose: (fleet: EcsManagementFleet) => Effect.Effect<EcsManagementState, any, any>;
  /** How deploys reach the composed runner. */
  readonly client: FleetManagementService;
}
