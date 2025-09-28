import { XMLParser } from "fast-xml-parser";
import type { Context } from "../../context.ts";
import { Resource } from "../../resource.ts";
import { ignore } from "../../util/ignore.ts";
import { logger } from "../../util/logger.ts";
import {
  mergeTimeoutConfig,
  type TimeoutConfig,
  waitForResourceState,
} from "../../util/timeout.ts";
import type { AwsClientProps } from "../client-props.ts";
import type { Subnet } from "./subnet.ts";
import { callEC2Api, createEC2Client } from "./utils.ts";

/**
 * Properties for creating or updating a NAT Gateway
 */
export interface NatGatewayProps extends AwsClientProps {
  /**
   * The subnet to create the NAT Gateway in (must be a public subnet)
   */
  subnet: Subnet | string;

  /**
   * The allocation ID of an existing Elastic IP address
   * If not provided, a new Elastic IP will be allocated
   */
  allocationId?: string;

  /**
   * The connectivity type for the NAT Gateway
   * @default "public"
   */
  connectivityType?: "public" | "private";

  /**
   * Tags to apply to the NAT Gateway
   */
  tags?: Record<string, string>;

  /**
   * Timeout configuration for NAT Gateway operations
   * @default NAT Gateway-specific sensible defaults (60 attempts, 5000ms delay)
   */
  timeout?: Partial<TimeoutConfig>;
}

/**
 * Output returned after NAT Gateway creation/update
 */
export interface NatGateway extends NatGatewayProps {
  /**
   * The ID of the NAT Gateway
   */
  natGatewayId: string;

  /**
   * The ID of the subnet the NAT Gateway is in
   */
  subnetId: string;

  /**
   * The ID of the VPC the NAT Gateway belongs to
   */
  vpcId: string;

  /**
   * The current state of the NAT Gateway
   */
  state: "pending" | "failed" | "available" | "deleting" | "deleted";

  /**
   * The allocation ID of the Elastic IP address
   */
  allocationId: string;

  /**
   * The public IP address of the NAT Gateway
   */
  publicIp?: string;

  /**
   * The private IP address of the NAT Gateway
   */
  privateIp?: string;

  /**
   * Whether the Elastic IP was created by this resource
   */
  createdElasticIp: boolean;
}

/**
 * AWS NAT Gateway Resource
 *
 * Creates and manages NAT Gateways that provide outbound internet access
 * for instances in private subnets. Automatically allocates an Elastic IP
 * if one is not provided. NAT Gateways are slow resources that can take
 * up to 10 minutes to become available.
 *
 * Supports AWS credential overrides at the resource level, allowing you to deploy NAT Gateways
 * to different AWS accounts or regions than the default scope configuration.
 *
 * @example
 * ```typescript
 * // Create a NAT Gateway with automatic Elastic IP allocation
 * const natGateway = await NatGateway("main-nat", {
 *   subnet: publicSubnet,
 *   tags: {
 *     Name: "main-nat-gateway",
 *     Environment: "production"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create NAT Gateway with AWS credential overrides
 * const crossAccountNat = await NatGateway("cross-account-nat", {
 *   subnet: publicSubnet,
 *   // Override AWS credentials for this specific resource
 *   region: "us-east-1",
 *   profile: "production-account",
 *   tags: {
 *     Name: "cross-account-nat-gateway",
 *     Environment: "production"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create NAT Gateway in different region with role assumption
 * const multiRegionNat = await NatGateway("multi-region-nat", {
 *   subnet: euPublicSubnet,
 *   region: "eu-west-1",
 *   roleArn: "arn:aws:iam::123456789012:role/CrossRegionRole",
 *   roleSessionName: "nat-gateway-deployment",
 *   tags: {
 *     Name: "eu-nat-gateway",
 *     Region: "europe"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create NAT Gateway with explicit credentials
 * const explicitCredsNat = await NatGateway("explicit-creds-nat", {
 *   subnet: testPublicSubnet,
 *   accessKeyId: alchemy.secret("AKIAIOSFODNN7EXAMPLE"),
 *   secretAccessKey: alchemy.secret("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
 *   region: "us-west-2",
 *   tags: {
 *     Name: "explicit-credentials-nat",
 *     Purpose: "testing"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create a NAT Gateway with existing Elastic IP
 * const natGateway = await NatGateway("custom-nat", {
 *   subnet: "subnet-12345678",
 *   allocationId: "eipalloc-12345678",
 *   connectivityType: "public",
 *   tags: {
 *     Name: "custom-nat-gateway"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create a private NAT Gateway (for VPC-to-VPC communication)
 * const privateNat = await NatGateway("private-nat", {
 *   subnet: privateSubnet,
 *   connectivityType: "private",
 *   tags: {
 *     Name: "private-nat-gateway",
 *     Type: "internal"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Create a NAT Gateway with custom timeout configuration
 * const slowNat = await NatGateway("slow-nat", {
 *   subnet: publicSubnet,
 *   timeout: {
 *     maxAttempts: 180, // Wait up to 15 minutes
 *     delayMs: 5000     // Check every 5 seconds
 *   },
 *   tags: {
 *     Name: "slow-nat-gateway"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Multi-account deployment with scope-level and resource-level overrides
 * await alchemy.run("production", {
 *   aws: { region: "us-west-2", profile: "main-account" }
 * }, async () => {
 *   // This NAT Gateway uses scope credentials (main-account, us-west-2)
 *   const mainNat = await NatGateway("main-nat", {
 *     subnet: mainPublicSubnet,
 *     tags: { Name: "main-account-nat" }
 *   });
 *
 *   // This NAT Gateway overrides to use different account
 *   const crossAccountNat = await NatGateway("cross-account-nat", {
 *     subnet: crossPublicSubnet,
 *     profile: "secondary-account",
 *     region: "us-east-1", // Also override region
 *     tags: { Name: "secondary-account-nat" }
 *   });
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Use NAT Gateway in route table for private subnet internet access
 * const privateRoute = await Route("private-internet", {
 *   routeTable: privateRouteTable,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   natGateway: natGateway,
 *   tags: {
 *     Name: "private-to-internet"
 *   }
 * });
 * ```
 */
export const NatGateway = Resource(
  "aws::NatGateway",
  async function (
    this: Context<NatGateway>,
    _id: string,
    props: NatGatewayProps,
  ): Promise<NatGateway> {
    // Create EC2 client with credential resolution handled internally
    const client = await createEC2Client(props);
    const subnetId =
      typeof props.subnet === "string" ? props.subnet : props.subnet.subnetId;
    const timeoutConfig = mergeTimeoutConfig(
      NAT_GATEWAY_TIMEOUT,
      props.timeout,
    );

    if (this.phase === "delete") {
      if (this.output?.natGatewayId) {
        logger.log(`🗑️ Deleting NAT Gateway: ${this.output.natGatewayId}`);
        // Delete NAT Gateway if it exists
        await ignore("InvalidNatGatewayID.NotFound", async () => {
          await callEC2Api(
            client,
            "DeleteNatGateway",
            parseNatGatewayXmlResponse,
            convertDeleteNatGatewayParamsToAwsFormat({
              NatGatewayId: this.output!.natGatewayId,
            }),
          );
        });

        // Wait for NAT Gateway to be deleted AND network interfaces to be cleaned up
        logger.log(
          `  Waiting for NAT Gateway ${this.output.natGatewayId} to be fully deleted...`,
        );
        await waitForNatGatewayFullyDeleted(
          this.output.natGatewayId,
          timeoutConfig,
          props,
        );

        logger.log(
          `  ✅ NAT Gateway ${this.output.natGatewayId} deletion completed`,
        );

        // Release Elastic IP if we created it and it exists
        if (this.output.createdElasticIp && this.output.allocationId) {
          logger.log(`  Releasing Elastic IP: ${this.output.allocationId}`);
          await ignore(
            ["InvalidAllocationID.NotFound", "InvalidAddress.NotFound"],
            async () => {
              await callEC2Api(
                client,
                "ReleaseAddress",
                parseNatGatewayXmlResponse,
                convertReleaseAddressParamsToAwsFormat({
                  AllocationId: this.output!.allocationId,
                }),
              );
            },
          );
          // Wait for the EIP to be fully released
          await waitForEipReleased(
            this.output.allocationId,
            timeoutConfig,
            props,
          );
          logger.log(
            `  ✅ Elastic IP ${this.output.allocationId} released successfully`,
          );
        }
      }
      return this.destroy();
    }

    let natGateway: AwsNatGateway;
    let allocationId = props.allocationId;
    let createdElasticIp = false;
    let publicIp: string | undefined;

    if (this.phase === "update" && this.output?.natGatewayId) {
      // Get existing NAT Gateway
      const response = await callEC2Api<DescribeNatGatewaysResponse>(
        client,
        "DescribeNatGateways",
        parseNatGatewayXmlResponse,
        convertDescribeNatGatewaysParamsToAwsFormat({
          NatGatewayIds: [this.output.natGatewayId],
        }),
      );

      if (!response.NatGateways?.[0]) {
        throw new Error(`NAT Gateway ${this.output.natGatewayId} not found`);
      }

      natGateway = response.NatGateways[0];
      allocationId = this.output.allocationId;
      createdElasticIp = this.output.createdElasticIp;
      publicIp = this.output.publicIp;
    } else {
      // Allocate Elastic IP if not provided
      if (!allocationId) {
        const eipParams: AllocateAddressParams = {
          Domain: "vpc",
        };

        // Add tags if specified
        if (props.tags) {
          eipParams.TagSpecifications = [
            {
              ResourceType: "elastic-ip",
              Tags: Object.entries(props.tags).map(([key, value]) => ({
                Key: `${key}-eip`,
                Value: value,
              })),
            },
          ];
        }

        const eipResponse = await callEC2Api<AllocateAddressResponse>(
          client,
          "AllocateAddress",
          parseNatGatewayXmlResponse,
          convertAllocateAddressParamsToAwsFormat(eipParams),
        );

        if (!eipResponse.AllocationId) {
          throw new Error("Failed to allocate Elastic IP");
        }

        allocationId = eipResponse.AllocationId;
        publicIp = eipResponse.PublicIp;
        createdElasticIp = true;
      } else {
        // Get public IP of existing allocation
        const addressResponse = await callEC2Api<DescribeAddressesResponse>(
          client,
          "DescribeAddresses",
          parseNatGatewayXmlResponse,
          convertDescribeAddressesParamsToAwsFormat({
            AllocationIds: [allocationId],
          }),
        );
        publicIp = addressResponse.Addresses?.[0]?.PublicIp;
      }

      // Create NAT Gateway
      const createParams: CreateNatGatewayParams = {
        SubnetId: subnetId,
        AllocationId: allocationId,
        ConnectivityType: props.connectivityType || "public",
      };

      // Add tags if specified
      if (props.tags) {
        createParams.TagSpecifications = [
          {
            ResourceType: "natgateway",
            Tags: Object.entries(props.tags).map(([key, value]) => ({
              Key: key,
              Value: value,
            })),
          },
        ];
      }

      const response = await callEC2Api<CreateNatGatewayResponse>(
        client,
        "CreateNatGateway",
        parseNatGatewayXmlResponse,
        convertCreateNatGatewayParamsToAwsFormat(createParams),
      );

      if (!response.NatGateway) {
        throw new Error("Failed to create NAT Gateway");
      }

      natGateway = response.NatGateway;

      // Wait for NAT Gateway to be available
      await waitForNatGatewayAvailable(
        natGateway.NatGatewayId!,
        timeoutConfig,
        props,
      );
    }

    const result = {
      natGatewayId: natGateway.NatGatewayId!,
      subnetId: natGateway.SubnetId!,
      vpcId: natGateway.VpcId!,
      state: natGateway.State,
      allocationId: allocationId!,
      publicIp,
      privateIp: natGateway.NatGatewayAddresses?.[0]?.PrivateIp,
      createdElasticIp,
      ...props,
      subnet: subnetId,
    };
    return result;
  },
);

/**
 * Wait for NAT Gateway to be in available state
 */
async function waitForNatGatewayAvailable(
  natGatewayId: string,
  timeoutConfig: TimeoutConfig,
  credentials?: AwsClientProps,
): Promise<void> {
  const checkFunction = async () => {
    const client = await createEC2Client(credentials);
    const response = await callEC2Api<DescribeNatGatewaysResponse>(
      client,
      "DescribeNatGateways",
      parseNatGatewayXmlResponse,
      convertDescribeNatGatewaysParamsToAwsFormat({
        NatGatewayIds: [natGatewayId],
      }),
    );
    return response.NatGateways?.[0];
  };

  const isReady = (natGateway: AwsNatGateway | undefined) => {
    // Check for non-retryable failure states
    if (natGateway?.State === "failed") {
      throw new NatGatewayNonRetryableError(
        `NAT Gateway ${natGatewayId} failed to create`,
      );
    }
    return natGateway?.State === "available";
  };

  await waitForResourceState(
    checkFunction,
    isReady,
    timeoutConfig,
    natGatewayId,
    "NAT Gateway",
    "is now available",
  );
}
/**
 * Wait for NAT Gateway to be deleted
 */
async function waitForNatGatewayDeleted(
  natGatewayId: string,
  timeoutConfig: TimeoutConfig,
  credentials?: AwsClientProps,
): Promise<void> {
  const checkFunction = async () => {
    try {
      const client = await createEC2Client(credentials);
      const response = await callEC2Api<DescribeNatGatewaysResponse>(
        client,
        "DescribeNatGateways",
        parseNatGatewayXmlResponse,
        convertDescribeNatGatewaysParamsToAwsFormat({
          NatGatewayIds: [natGatewayId],
        }),
      );
      return response.NatGateways?.[0];
    } catch (error: any) {
      // If NAT Gateway is not found, it's been deleted - return undefined
      if (
        error.code === "InvalidNatGatewayID.NotFound" ||
        error.code === "InvalidNatGateway.NotFound" ||
        error.code === "NatGatewayNotFound"
      ) {
        return undefined;
      }
      throw error;
    }
  };

  const isReady = (natGateway: AwsNatGateway | undefined) => {
    // NAT Gateway is deleted if it doesn't exist or is in deleted state
    return !natGateway || natGateway.State === "deleted";
  };

  await waitForResourceState(
    checkFunction,
    isReady,
    timeoutConfig,
    natGatewayId,
    "NAT Gateway",
    "deletion completed",
  );
}

/**
 * Parse XML response for DescribeNetworkInterfaces
 */
function parseDescribeNetworkInterfacesResponse(
  xmlText: string,
): DescribeNetworkInterfacesResponse {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
  });
  const parsed = parser.parse(xmlText);
  const result: DescribeNetworkInterfacesResponse = { NetworkInterfaces: [] };
  if (parsed.DescribeNetworkInterfacesResponse) {
    const networkInterfaceSet =
      parsed.DescribeNetworkInterfacesResponse.networkInterfaceSet;
    if (networkInterfaceSet?.item) {
      const items: RawNetworkInterfaceXmlItem[] = Array.isArray(
        networkInterfaceSet.item,
      )
        ? networkInterfaceSet.item
        : [networkInterfaceSet.item];

      result.NetworkInterfaces = items.map(
        (item): AwsNetworkInterface => ({
          NetworkInterfaceId: item.networkInterfaceId,
          Description: item.description,
          Status: item.status as AwsNetworkInterface["Status"],
        }),
      );
    }
  }
  return result;
}

/**
 * Wait for an Elastic IP to be released.
 */
async function waitForEipReleased(
  allocationId: string,
  timeoutConfig: TimeoutConfig,
  credentials?: AwsClientProps,
): Promise<void> {
  const checkFunction = async () => {
    try {
      const eipClient = await createEC2Client(credentials);
      const addressResponse = await callEC2Api<DescribeAddressesResponse>(
        eipClient,
        "DescribeAddresses",
        parseNatGatewayXmlResponse,
        convertDescribeAddressesParamsToAwsFormat({
          AllocationIds: [allocationId],
        }),
      );
      return addressResponse.Addresses?.[0];
    } catch (error: any) {
      if (
        error.code === "InvalidAllocationID.NotFound" ||
        error.code === "InvalidAddress.NotFound"
      ) {
        return undefined;
      }
      throw error;
    }
  };

  const isReady = (address: AwsAddress | undefined) => {
    return !address;
  };

  await waitForResourceState(
    checkFunction,
    isReady,
    timeoutConfig,
    allocationId,
    "Elastic IP",
    "to be released",
  );
}

/**
 * Wait for NAT Gateway to be fully deleted including network interface cleanup
 */
async function waitForNatGatewayFullyDeleted(
  natGatewayId: string,
  timeoutConfig: TimeoutConfig,
  credentials?: AwsClientProps,
): Promise<void> {
  // First wait for the NAT Gateway itself to be deleted
  await waitForNatGatewayDeleted(natGatewayId, timeoutConfig, credentials);

  // Then wait for network interfaces to be cleaned up
  const checkNetworkInterfaces = async () => {
    try {
      const client = await createEC2Client(credentials);
      const response = await callEC2Api<DescribeNetworkInterfacesResponse>(
        client,
        "DescribeNetworkInterfaces",
        parseDescribeNetworkInterfacesResponse,
        {
          "Filter.1.Name": "description",
          "Filter.1.Value.1": `Interface for NAT Gateway ${natGatewayId}`,
        },
      );

      return response.NetworkInterfaces || [];
    } catch (error: any) {
      // If we can't check network interfaces, assume cleanup is complete
      logger.log(
        `  Could not check network interfaces for NAT Gateway ${natGatewayId}, assuming cleanup complete`,
        error,
      );
      return [];
    }
  };

  const isNetworkInterfacesCleanedUp = (
    networkInterfaces: AwsNetworkInterface[],
  ) => {
    if (networkInterfaces.length > 0) {
      logger.log(
        `  NAT Gateway ${natGatewayId} still has ${networkInterfaces.length} network interfaces, waiting for cleanup...`,
      );
      return false;
    }
    return true;
  };

  await waitForResourceState(
    checkNetworkInterfaces,
    isNetworkInterfacesCleanedUp,
    timeoutConfig,
    natGatewayId,
    "NAT Gateway network interfaces",
    "cleanup completed",
  );
}

/**
 * Non-retryable error for NAT Gateway operations
 */
export class NatGatewayNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NatGatewayNonRetryableError";
  }
}

/**
 * NAT Gateway timeout constants
 */
export const NAT_GATEWAY_TIMEOUT: TimeoutConfig = {
  maxAttempts: 120, // NAT Gateways are slow resources - can take up to 10 minutes
  delayMs: 5000, // Check every 5 seconds
};

/**
 * AWS NAT Gateway and related API response types
 */
interface AwsNatGatewayAddress {
  AllocationId?: string;
  NetworkInterfaceId?: string;
  PrivateIp?: string;
  PublicIp?: string;
}

interface AwsTag {
  Key: string;
  Value: string;
}

interface AwsNatGateway {
  NatGatewayId: string;
  SubnetId: string;
  VpcId: string;
  State: "pending" | "failed" | "available" | "deleting" | "deleted";
  ConnectivityType?: "public" | "private";
  NatGatewayAddresses?: AwsNatGatewayAddress[];
  Tags?: AwsTag[];
  CreateTime?: string;
  DeleteTime?: string;
  FailureCode?: string;
  FailureMessage?: string;
}

interface AwsAddress {
  AllocationId: string;
  PublicIp: string;
  PrivateIpAddress?: string;
  Domain: string;
}

interface AwsNetworkInterface {
  NetworkInterfaceId: string;
  Description?: string;
  Status: "available" | "attaching" | "in-use" | "detaching";
}

interface CreateNatGatewayResponse {
  NatGateway: AwsNatGateway;
}

interface DescribeNatGatewaysResponse {
  NatGateways: AwsNatGateway[];
}

interface DescribeAddressesResponse {
  Addresses: AwsAddress[];
}

interface DescribeNetworkInterfacesResponse {
  NetworkInterfaces: AwsNetworkInterface[];
}

/**
 * Raw XML parsing interfaces for type safety
 */
interface RawNatGatewayAddressXmlItem {
  allocationId?: string;
  networkInterfaceId?: string;
  privateIp?: string;
  publicIp?: string;
}

interface RawTagXmlItem {
  key: string;
  value: string;
}

interface RawNatGatewayXmlItem {
  natGatewayId: string;
  subnetId: string;
  vpcId: string;
  state: string;
  connectivityType?: string;
  natGatewayAddressSet?: {
    item?: RawNatGatewayAddressXmlItem | RawNatGatewayAddressXmlItem[];
  };
  tagSet?: {
    item?: RawTagXmlItem | RawTagXmlItem[];
  };
  createTime?: string;
  deleteTime?: string;
  failureCode?: string;
  failureMessage?: string;
}

interface RawAddressXmlItem {
  allocationId: string;
  publicIp: string;
  privateIpAddress?: string;
  domain: string;
}

interface RawNetworkInterfaceXmlItem {
  networkInterfaceId: string;
  description?: string;
  status: string;
}

/**
 * Parse XML responses specifically for NAT Gateway operations
 */
function parseNatGatewayXmlResponse<T>(xmlText: string): T {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlText);
  const result: Record<string, unknown> = {};

  // Parse CreateNatGatewayResponse
  if (parsed.CreateNatGatewayResponse) {
    const natGateway = parsed.CreateNatGatewayResponse
      .natGateway as RawNatGatewayXmlItem;
    if (natGateway) {
      const addresses = natGateway.natGatewayAddressSet?.item
        ? Array.isArray(natGateway.natGatewayAddressSet.item)
          ? natGateway.natGatewayAddressSet.item
          : [natGateway.natGatewayAddressSet.item]
        : [];

      const tags = natGateway.tagSet?.item
        ? Array.isArray(natGateway.tagSet.item)
          ? natGateway.tagSet.item
          : [natGateway.tagSet.item]
        : [];

      result.NatGateway = {
        NatGatewayId: natGateway.natGatewayId,
        SubnetId: natGateway.subnetId,
        VpcId: natGateway.vpcId,
        State: natGateway.state as AwsNatGateway["State"],
        ConnectivityType: natGateway.connectivityType as
          | "public"
          | "private"
          | undefined,
        NatGatewayAddresses: addresses.map(
          (address): AwsNatGatewayAddress => ({
            AllocationId: address.allocationId,
            NetworkInterfaceId: address.networkInterfaceId,
            PrivateIp: address.privateIp,
            PublicIp: address.publicIp,
          }),
        ),
        Tags: tags.map(
          (tag): AwsTag => ({
            Key: tag.key,
            Value: tag.value,
          }),
        ),
        CreateTime: natGateway.createTime,
        DeleteTime: natGateway.deleteTime,
        FailureCode: natGateway.failureCode,
        FailureMessage: natGateway.failureMessage,
      };
    }
  }

  // Parse DescribeNatGatewaysResponse
  if (parsed.DescribeNatGatewaysResponse) {
    const natGatewaySet = parsed.DescribeNatGatewaysResponse.natGatewaySet;
    if (natGatewaySet?.item) {
      const natGateways: RawNatGatewayXmlItem[] = Array.isArray(
        natGatewaySet.item,
      )
        ? natGatewaySet.item
        : [natGatewaySet.item];
      result.NatGateways = natGateways.map((natGateway): AwsNatGateway => {
        const addresses = natGateway.natGatewayAddressSet?.item
          ? Array.isArray(natGateway.natGatewayAddressSet.item)
            ? natGateway.natGatewayAddressSet.item
            : [natGateway.natGatewayAddressSet.item]
          : [];

        const tags = natGateway.tagSet?.item
          ? Array.isArray(natGateway.tagSet.item)
            ? natGateway.tagSet.item
            : [natGateway.tagSet.item]
          : [];

        return {
          NatGatewayId: natGateway.natGatewayId,
          SubnetId: natGateway.subnetId,
          VpcId: natGateway.vpcId,
          State: natGateway.state as AwsNatGateway["State"],
          ConnectivityType: natGateway.connectivityType as
            | "public"
            | "private"
            | undefined,
          NatGatewayAddresses: addresses.map(
            (address): AwsNatGatewayAddress => ({
              AllocationId: address.allocationId,
              NetworkInterfaceId: address.networkInterfaceId,
              PrivateIp: address.privateIp,
              PublicIp: address.publicIp,
            }),
          ),
          Tags: tags.map(
            (tag): AwsTag => ({
              Key: tag.key,
              Value: tag.value,
            }),
          ),
          CreateTime: natGateway.createTime,
          DeleteTime: natGateway.deleteTime,
          FailureCode: natGateway.failureCode,
          FailureMessage: natGateway.failureMessage,
        };
      });
    } else {
      result.NatGateways = [];
    }
  }

  // Parse AllocateAddressResponse (for EIP allocation)
  if (parsed.AllocateAddressResponse) {
    result.AllocationId = parsed.AllocateAddressResponse.allocationId;
    result.PublicIp = parsed.AllocateAddressResponse.publicIp;
  }

  // Parse DescribeAddressesResponse (for EIP lookup)
  if (parsed.DescribeAddressesResponse) {
    const addressesSet = parsed.DescribeAddressesResponse.addressesSet;
    if (addressesSet?.item) {
      const addresses: RawAddressXmlItem[] = Array.isArray(addressesSet.item)
        ? addressesSet.item
        : [addressesSet.item];
      result.Addresses = addresses.map(
        (address): AwsAddress => ({
          AllocationId: address.allocationId,
          PublicIp: address.publicIp,
          PrivateIpAddress: address.privateIpAddress,
          Domain: address.domain,
        }),
      );
    } else {
      result.Addresses = [];
    }
  }

  // Handle success responses
  if (parsed.DeleteNatGatewayResponse || parsed.ReleaseAddressResponse) {
    result.success = true;
  }

  return result as T;
}

interface AllocateAddressResponse {
  AllocationId: string;
  PublicIp: string;
}

/**
 * Comprehensive AWS NAT Gateway API Parameter Types
 */

// Common structures
interface TagSpecification {
  ResourceType: string;
  Tags: Array<{
    Key: string;
    Value: string;
  }>;
}

interface Filter {
  Name: string;
  Values: string[];
}

// NAT Gateway API Request Parameters
interface CreateNatGatewayParams {
  SubnetId: string;
  AllocationId?: string;
  ConnectivityType?: "public" | "private";
  TagSpecifications?: TagSpecification[];
  DryRun?: boolean;
  ClientToken?: string;
}

interface DescribeNatGatewaysParams {
  NatGatewayIds?: string[];
  Filters?: Filter[];
  NextToken?: string;
  MaxResults?: number;
  DryRun?: boolean;
}

interface DeleteNatGatewayParams {
  NatGatewayId: string;
  DryRun?: boolean;
}

// Elastic IP API Request Parameters
interface AllocateAddressParams {
  Domain?: "vpc" | "standard";
  Address?: string;
  PublicIpv4Pool?: string;
  NetworkBorderGroup?: string;
  CustomerOwnedIpv4Pool?: string;
  TagSpecifications?: TagSpecification[];
  DryRun?: boolean;
}

interface DescribeAddressesParams {
  AllocationIds?: string[];
  PublicIps?: string[];
  Filters?: Filter[];
  DryRun?: boolean;
}

interface ReleaseAddressParams {
  AllocationId?: string;
  PublicIp?: string;
  NetworkBorderGroup?: string;
  DryRun?: boolean;
}

/**
 * Helper functions to convert typed parameters to AWS API format
 */
function convertCreateNatGatewayParamsToAwsFormat(
  params: CreateNatGatewayParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {
    SubnetId: params.SubnetId,
  };

  if (params.AllocationId !== undefined) {
    awsParams.AllocationId = params.AllocationId;
  }

  if (params.ConnectivityType !== undefined) {
    awsParams.ConnectivityType = params.ConnectivityType;
  }

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  if (params.ClientToken !== undefined) {
    awsParams.ClientToken = params.ClientToken;
  }

  // Handle TagSpecifications
  if (params.TagSpecifications) {
    params.TagSpecifications.forEach((tagSpec, specIndex) => {
      const specNum = specIndex + 1;
      awsParams[`TagSpecification.${specNum}.ResourceType`] =
        tagSpec.ResourceType;

      tagSpec.Tags.forEach((tag, tagIndex) => {
        const tagNum = tagIndex + 1;
        awsParams[`TagSpecification.${specNum}.Tag.${tagNum}.Key`] = tag.Key;
        awsParams[`TagSpecification.${specNum}.Tag.${tagNum}.Value`] =
          tag.Value;
      });
    });
  }

  return awsParams;
}

function convertDescribeNatGatewaysParamsToAwsFormat(
  params: DescribeNatGatewaysParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {};

  if (params.NatGatewayIds) {
    params.NatGatewayIds.forEach((id, index) => {
      awsParams[`NatGatewayId.${index + 1}`] = id;
    });
  }

  if (params.Filters) {
    params.Filters.forEach((filter, filterIndex) => {
      const filterNum = filterIndex + 1;
      awsParams[`Filter.${filterNum}.Name`] = filter.Name;
      filter.Values.forEach((value, valueIndex) => {
        awsParams[`Filter.${filterNum}.Value.${valueIndex + 1}`] = value;
      });
    });
  }

  if (params.NextToken !== undefined) {
    awsParams.NextToken = params.NextToken;
  }

  if (params.MaxResults !== undefined) {
    awsParams.MaxResults = params.MaxResults.toString();
  }

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  return awsParams;
}

function convertDeleteNatGatewayParamsToAwsFormat(
  params: DeleteNatGatewayParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {
    NatGatewayId: params.NatGatewayId,
  };

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  return awsParams;
}

function convertAllocateAddressParamsToAwsFormat(
  params: AllocateAddressParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {};

  if (params.Domain !== undefined) {
    awsParams.Domain = params.Domain;
  }

  if (params.Address !== undefined) {
    awsParams.Address = params.Address;
  }

  if (params.PublicIpv4Pool !== undefined) {
    awsParams.PublicIpv4Pool = params.PublicIpv4Pool;
  }

  if (params.NetworkBorderGroup !== undefined) {
    awsParams.NetworkBorderGroup = params.NetworkBorderGroup;
  }

  if (params.CustomerOwnedIpv4Pool !== undefined) {
    awsParams.CustomerOwnedIpv4Pool = params.CustomerOwnedIpv4Pool;
  }

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  // Handle TagSpecifications
  if (params.TagSpecifications) {
    params.TagSpecifications.forEach((tagSpec, specIndex) => {
      const specNum = specIndex + 1;
      awsParams[`TagSpecification.${specNum}.ResourceType`] =
        tagSpec.ResourceType;

      tagSpec.Tags.forEach((tag, tagIndex) => {
        const tagNum = tagIndex + 1;
        awsParams[`TagSpecification.${specNum}.Tag.${tagNum}.Key`] = tag.Key;
        awsParams[`TagSpecification.${specNum}.Tag.${tagNum}.Value`] =
          tag.Value;
      });
    });
  }

  return awsParams;
}

function convertDescribeAddressesParamsToAwsFormat(
  params: DescribeAddressesParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {};

  if (params.AllocationIds) {
    params.AllocationIds.forEach((id, index) => {
      awsParams[`AllocationId.${index + 1}`] = id;
    });
  }

  if (params.PublicIps) {
    params.PublicIps.forEach((ip, index) => {
      awsParams[`PublicIp.${index + 1}`] = ip;
    });
  }

  if (params.Filters) {
    params.Filters.forEach((filter, filterIndex) => {
      const filterNum = filterIndex + 1;
      awsParams[`Filter.${filterNum}.Name`] = filter.Name;
      filter.Values.forEach((value, valueIndex) => {
        awsParams[`Filter.${filterNum}.Value.${valueIndex + 1}`] = value;
      });
    });
  }

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  return awsParams;
}

function convertReleaseAddressParamsToAwsFormat(
  params: ReleaseAddressParams,
): Record<string, string> {
  const awsParams: Record<string, string> = {};

  if (params.AllocationId !== undefined) {
    awsParams.AllocationId = params.AllocationId;
  }

  if (params.PublicIp !== undefined) {
    awsParams.PublicIp = params.PublicIp;
  }

  if (params.NetworkBorderGroup !== undefined) {
    awsParams.NetworkBorderGroup = params.NetworkBorderGroup;
  }

  if (params.DryRun !== undefined) {
    awsParams.DryRun = params.DryRun.toString();
  }

  return awsParams;
}
