import type * as EC2 from "distilled-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { RouteTableId } from "./route-table.ts";
import type { SecurityGroupId } from "./security-group.ts";
import type { SubnetId } from "./subnet.ts";
import type { VpcId } from "./vpc.ts";

export const VpcEndpoint = Resource<{
  <const ID extends string, const Props extends VpcEndpointProps>(
    id: ID,
    props: Props,
  ): VpcEndpoint<ID, Props>;
}>("AWS.EC2.VpcEndpoint");

export interface VpcEndpoint<
  ID extends string = string,
  Props extends VpcEndpointProps = VpcEndpointProps,
> extends Resource<
  "AWS.EC2.VpcEndpoint",
  ID,
  Props,
  VpcEndpointAttrs<Input.Resolve<Props>>,
  VpcEndpoint
> {}

export type VpcEndpointId<ID extends string = string> = `vpce-${ID}`;
export const VpcEndpointId = <ID extends string>(
  id: ID,
): ID & VpcEndpointId<ID> => `vpce-${id}` as ID & VpcEndpointId<ID>;

export interface VpcEndpointProps {
  /**
   * The VPC to create the endpoint in.
   */
  vpcId: Input<VpcId>;

  /**
   * The service name.
   * For AWS services, use the format: com.amazonaws.<region>.<service>
   * @example "com.amazonaws.us-east-1.s3"
   */
  serviceName: string;

  /**
   * The type of endpoint.
   * - Gateway: For S3 and DynamoDB (route table based)
   * - Interface: For most other AWS services (ENI based)
   * - GatewayLoadBalancer: For Gateway Load Balancer endpoints
   * @default "Gateway"
   */
  vpcEndpointType?: EC2.VpcEndpointType;

  /**
   * The IDs of route tables for a Gateway endpoint.
   * Required for Gateway endpoints.
   */
  routeTableIds?: Input<RouteTableId>[];

  /**
   * The IDs of subnets for an Interface endpoint.
   * Required for Interface endpoints.
   */
  subnetIds?: Input<SubnetId>[];

  /**
   * The IDs of security groups for an Interface endpoint.
   * Required for Interface endpoints.
   */
  securityGroupIds?: Input<SecurityGroupId>[];

  /**
   * Whether to associate a private hosted zone with the VPC.
   * Only applicable for Interface endpoints.
   * @default true
   */
  privateDnsEnabled?: boolean;

  /**
   * A policy to attach to the endpoint that controls access to the service.
   * The policy document must be in JSON format.
   */
  policyDocument?: string;

  /**
   * The IP address type for the endpoint.
   */
  ipAddressType?: EC2.IpAddressType;

  /**
   * The DNS options for the endpoint.
   */
  dnsOptions?: {
    dnsRecordIpType?: EC2.DnsRecordIpType;
    privateDnsOnlyForInboundResolverEndpoint?: boolean;
  };

  /**
   * Tags to assign to the VPC endpoint.
   */
  tags?: Record<string, Input<string>>;
}

export interface VpcEndpointAttrs<Props extends VpcEndpointProps> {
  /**
   * The ID of the VPC endpoint.
   */
  vpcEndpointId: VpcEndpointId;

  /**
   * The Amazon Resource Name (ARN) of the VPC endpoint.
   */
  vpcEndpointArn: `arn:aws:ec2:${RegionID}:${AccountID}:vpc-endpoint/${this["vpcEndpointId"]}`;

  /**
   * The type of endpoint.
   */
  vpcEndpointType: EC2.VpcEndpointType;

  /**
   * The ID of the VPC.
   */
  vpcId: Props["vpcId"];

  /**
   * The service name.
   */
  serviceName: Props["serviceName"];

  /**
   * The current state of the VPC endpoint.
   */
  state: EC2.State;

  /**
   * The policy document associated with the endpoint.
   */
  policyDocument?: string;

  /**
   * The IDs of the route tables associated with the endpoint.
   */
  routeTableIds?: string[];

  /**
   * The IDs of the subnets associated with the endpoint.
   */
  subnetIds?: string[];

  /**
   * Information about the security groups associated with the network interfaces.
   */
  groups?: Array<{
    groupId: string;
    groupName: string;
  }>;

  /**
   * Whether private DNS is enabled.
   */
  privateDnsEnabled?: boolean;

  /**
   * Whether the VPC endpoint is being managed by its service.
   */
  requesterManaged?: boolean;

  /**
   * The IDs of the network interfaces for the endpoint.
   */
  networkInterfaceIds?: string[];

  /**
   * The DNS entries for the endpoint.
   */
  dnsEntries?: Array<{
    dnsName?: string;
    hostedZoneId?: string;
  }>;

  /**
   * The date and time the VPC endpoint was created.
   */
  creationTimestamp?: string;

  /**
   * The ID of the AWS account that owns the VPC endpoint.
   */
  ownerId?: string;

  /**
   * The IP address type for the endpoint.
   */
  ipAddressType?: EC2.IpAddressType;

  /**
   * The DNS options for the endpoint.
   */
  dnsOptions?: {
    dnsRecordIpType?: EC2.DnsRecordIpType;
    privateDnsOnlyForInboundResolverEndpoint?: boolean;
  };

  /**
   * The last error that occurred for VPC endpoint.
   */
  lastError?: {
    code?: string;
    message?: string;
  };
}
