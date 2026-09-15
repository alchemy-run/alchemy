import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DhcpOptions } from "./DhcpOptions.ts";
import type { EIP } from "./EIP.ts";
import type { EgressOnlyInternetGateway } from "./EgressOnlyInternetGateway.ts";
import type { FlowLog } from "./FlowLog.ts";
import type { Instance } from "./Instance.ts";
import type { InternetGateway } from "./InternetGateway.ts";
import type { KeyPair } from "./KeyPair.ts";
import type { NatGateway } from "./NatGateway.ts";
import type { NetworkAcl } from "./NetworkAcl.ts";
import type { NetworkAclAssociation } from "./NetworkAclAssociation.ts";
import type { NetworkAclEntry } from "./NetworkAclEntry.ts";
import type { NetworkInterface } from "./NetworkInterface.ts";
import type { NetworkInterfaceAttachment } from "./NetworkInterfaceAttachment.ts";
import type { PrefixList } from "./PrefixList.ts";
import type { Route } from "./Route.ts";
import type { RouteTable } from "./RouteTable.ts";
import type { RouteTableAssociation } from "./RouteTableAssociation.ts";
import type { SecurityGroup } from "./SecurityGroup.ts";
import type { SecurityGroupRule } from "./SecurityGroupRule.ts";
import type { Snapshot } from "./Snapshot.ts";
import type { Subnet } from "./Subnet.ts";
import type { Volume } from "./Volume.ts";
import type { VolumeAttachment } from "./VolumeAttachment.ts";
import type { Vpc } from "./Vpc.ts";
import type { VpcEndpoint } from "./VpcEndpoint.ts";
import type { VpcPeeringConnection } from "./VpcPeeringConnection.ts";

/**
 * Dashboard UI providers for AWS EC2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS networking (VPC) brand purple. */
const NETWORK_PURPLE = "#8C4FFF";
/** AWS compute brand orange. */
const COMPUTE_ORANGE = "#ED7100";
/** AWS storage (EBS) brand green. */
const STORAGE_GREEN = "#7AA116";

/** Extract the region segment from an AWS ARN (arn:aws:svc:REGION:...). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

const vpcConsole = (
  region: string | undefined,
  hash: string,
): string | undefined =>
  region === undefined
    ? undefined
    : `https://${region}.console.aws.amazon.com/vpcconsole/home?region=${region}#${hash}`;

const ec2Console = (
  region: string | undefined,
  hash: string,
): string | undefined =>
  region === undefined
    ? undefined
    : `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#${hash}`;

export const VpcUI = UIProvider.succeed<Vpc>("AWS.EC2.VPC", {
  displayName: "VPC",
  icon: "network",
  color: NETWORK_PURPLE,
  category: "network",
  summary: (ctx) => ctx.attrs?.vpcId,
  consoleUrl: (ctx) =>
    ctx.attrs?.vpcId === undefined
      ? undefined
      : vpcConsole(
          regionOfArn(ctx.attrs?.vpcArn),
          `VpcDetails:VpcId=${ctx.attrs.vpcId}`,
        ),
  facts: (ctx) => [
    { label: "vpc id", value: ctx.attrs?.vpcId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.vpcArn, mono: true, copy: true },
    { label: "cidr", value: ctx.attrs?.cidrBlock, mono: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "default", value: ctx.attrs?.isDefault },
    { label: "dhcp options", value: ctx.attrs?.dhcpOptionsId, mono: true },
  ],
});

export const SubnetUI = UIProvider.succeed<Subnet>("AWS.EC2.Subnet", {
  displayName: "Subnet",
  icon: "grid-2x2",
  color: NETWORK_PURPLE,
  category: "network",
  summary: (ctx) => ctx.attrs?.subnetId,
  consoleUrl: (ctx) =>
    ctx.attrs?.subnetId === undefined
      ? undefined
      : vpcConsole(
          regionOfArn(ctx.attrs?.subnetArn),
          `SubnetDetails:SubnetId=${ctx.attrs.subnetId}`,
        ),
  facts: (ctx) => [
    { label: "subnet id", value: ctx.attrs?.subnetId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.subnetArn, mono: true, copy: true },
    { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
    { label: "cidr", value: ctx.attrs?.cidrBlock, mono: true },
    { label: "az", value: ctx.attrs?.availabilityZone },
    { label: "public ip on launch", value: ctx.attrs?.mapPublicIpOnLaunch },
    { label: "available ips", value: ctx.attrs?.availableIpAddressCount },
  ],
});

export const InstanceUI = UIProvider.succeed<Instance>("AWS.EC2.Instance", {
  displayName: "EC2 Instance",
  icon: "server",
  color: COMPUTE_ORANGE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.instanceId,
  link: (ctx) =>
    ctx.attrs?.publicDnsName ? `http://${ctx.attrs.publicDnsName}` : undefined,
  consoleUrl: (ctx) =>
    ctx.attrs?.instanceId === undefined
      ? undefined
      : ec2Console(
          regionOfArn(ctx.attrs?.instanceArn),
          `InstanceDetails:instanceId=${ctx.attrs.instanceId}`,
        ),
  facts: (ctx) => [
    {
      label: "instance id",
      value: ctx.attrs?.instanceId,
      mono: true,
      copy: true,
    },
    { label: "type", value: ctx.attrs?.instanceType },
    { label: "state", value: ctx.attrs?.state },
    { label: "ami", value: ctx.attrs?.imageId, mono: true },
    { label: "az", value: ctx.attrs?.availabilityZone },
    { label: "public ip", value: ctx.attrs?.publicIpAddress, mono: true },
    { label: "private ip", value: ctx.attrs?.privateIpAddress, mono: true },
    { label: "subnet", value: ctx.attrs?.subnetId, mono: true },
  ],
});

export const SecurityGroupUI = UIProvider.succeed<SecurityGroup>(
  "AWS.EC2.SecurityGroup",
  {
    displayName: "Security Group",
    icon: "shield",
    color: COMPUTE_ORANGE,
    category: "security",
    summary: (ctx) => ctx.attrs?.groupName ?? ctx.attrs?.groupId,
    consoleUrl: (ctx) =>
      ctx.attrs?.groupId === undefined
        ? undefined
        : ec2Console(
            regionOfArn(ctx.attrs?.groupArn),
            `SecurityGroup:groupId=${ctx.attrs.groupId}`,
          ),
    facts: (ctx) => [
      { label: "group id", value: ctx.attrs?.groupId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.groupName },
      { label: "arn", value: ctx.attrs?.groupArn, mono: true, copy: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "description", value: ctx.attrs?.description },
      { label: "ingress rules", value: ctx.attrs?.ingressRules?.length },
      { label: "egress rules", value: ctx.attrs?.egressRules?.length },
    ],
  },
);

export const SecurityGroupRuleUI = UIProvider.succeed<SecurityGroupRule>(
  "AWS.EC2.SecurityGroupRule",
  {
    displayName: "Security Group Rule",
    icon: "shield-check",
    color: COMPUTE_ORANGE,
    category: "security",
    summary: (ctx) => ctx.attrs?.securityGroupRuleId,
    facts: (ctx) => [
      {
        label: "rule id",
        value: ctx.attrs?.securityGroupRuleId,
        mono: true,
        copy: true,
      },
      { label: "group", value: ctx.attrs?.groupId, mono: true },
      {
        label: "direction",
        value:
          ctx.attrs?.isEgress === undefined
            ? undefined
            : ctx.attrs.isEgress
              ? "egress"
              : "ingress",
      },
      { label: "protocol", value: ctx.attrs?.ipProtocol },
      {
        label: "ports",
        value:
          ctx.attrs?.fromPort === undefined
            ? undefined
            : ctx.attrs.fromPort === ctx.attrs.toPort
              ? ctx.attrs.fromPort
              : `${ctx.attrs.fromPort}-${ctx.attrs.toPort}`,
      },
      {
        label: "source",
        value:
          ctx.attrs?.cidrIpv4 ??
          ctx.attrs?.cidrIpv6 ??
          ctx.attrs?.referencedGroupId ??
          ctx.attrs?.prefixListId,
        mono: true,
      },
    ],
  },
);

export const KeyPairUI = UIProvider.succeed<KeyPair>("AWS.EC2.KeyPair", {
  displayName: "EC2 Key Pair",
  icon: "key-round",
  color: COMPUTE_ORANGE,
  category: "security",
  summary: (ctx) => ctx.attrs?.keyName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.keyName, copy: true },
    { label: "key id", value: ctx.attrs?.keyPairId, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.keyType },
    { label: "fingerprint", value: ctx.attrs?.keyFingerprint, mono: true },
  ],
});

export const EIPUI = UIProvider.succeed<EIP>("AWS.EC2.EIP", {
  displayName: "Elastic IP",
  icon: "map-pin",
  color: NETWORK_PURPLE,
  category: "network",
  summary: (ctx) => ctx.attrs?.publicIp,
  consoleUrl: (ctx) =>
    ctx.attrs?.allocationId === undefined
      ? undefined
      : ec2Console(
          regionOfArn(ctx.attrs?.eipArn),
          `ElasticIpDetails:AllocationId=${ctx.attrs.allocationId}`,
        ),
  facts: (ctx) => [
    { label: "public ip", value: ctx.attrs?.publicIp, mono: true, copy: true },
    {
      label: "allocation id",
      value: ctx.attrs?.allocationId,
      mono: true,
      copy: true,
    },
    { label: "arn", value: ctx.attrs?.eipArn, mono: true, copy: true },
    { label: "domain", value: ctx.attrs?.domain },
    { label: "network border group", value: ctx.attrs?.networkBorderGroup },
  ],
});

export const InternetGatewayUI = UIProvider.succeed<InternetGateway>(
  "AWS.EC2.InternetGateway",
  {
    displayName: "Internet Gateway",
    icon: "globe",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.internetGatewayId,
    consoleUrl: (ctx) =>
      ctx.attrs?.internetGatewayId === undefined
        ? undefined
        : vpcConsole(
            regionOfArn(ctx.attrs?.internetGatewayArn),
            `InternetGatewayDetails:internetGatewayId=${ctx.attrs.internetGatewayId}`,
          ),
    facts: (ctx) => [
      {
        label: "gateway id",
        value: ctx.attrs?.internetGatewayId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.internetGatewayArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "attachment",
        value: ctx.attrs?.attachments?.[0]?.state,
      },
    ],
  },
);

export const EgressOnlyInternetGatewayUI =
  UIProvider.succeed<EgressOnlyInternetGateway>(
    "AWS.EC2.EgressOnlyInternetGateway",
    {
      displayName: "Egress-Only Internet Gateway",
      icon: "arrow-up-right",
      color: NETWORK_PURPLE,
      category: "network",
      summary: (ctx) => ctx.attrs?.egressOnlyInternetGatewayId,
      facts: (ctx) => [
        {
          label: "gateway id",
          value: ctx.attrs?.egressOnlyInternetGatewayId,
          mono: true,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.egressOnlyInternetGatewayArn,
          mono: true,
          copy: true,
        },
        {
          label: "vpc",
          value: ctx.attrs?.attachments?.[0]?.vpcId,
          mono: true,
        },
        {
          label: "attachment",
          value: ctx.attrs?.attachments?.[0]?.state,
        },
      ],
    },
  );

export const NatGatewayUI = UIProvider.succeed<NatGateway>(
  "AWS.EC2.NatGateway",
  {
    displayName: "NAT Gateway",
    icon: "arrow-right-left",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.natGatewayId,
    consoleUrl: (ctx) =>
      ctx.attrs?.natGatewayId === undefined
        ? undefined
        : vpcConsole(
            regionOfArn(ctx.attrs?.natGatewayArn),
            `NatGatewayDetails:natGatewayId=${ctx.attrs.natGatewayId}`,
          ),
    facts: (ctx) => [
      {
        label: "gateway id",
        value: ctx.attrs?.natGatewayId,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
      { label: "connectivity", value: ctx.attrs?.connectivityType },
      { label: "public ip", value: ctx.attrs?.publicIp, mono: true },
      { label: "private ip", value: ctx.attrs?.privateIp, mono: true },
      { label: "subnet", value: ctx.attrs?.subnetId, mono: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
    ],
  },
);

export const RouteTableUI = UIProvider.succeed<RouteTable>(
  "AWS.EC2.RouteTable",
  {
    displayName: "Route Table",
    icon: "table",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.routeTableId,
    consoleUrl: (ctx) =>
      ctx.attrs?.routeTableId === undefined
        ? undefined
        : vpcConsole(
            regionOfArn(ctx.attrs?.routeTableArn),
            `RouteTableDetails:RouteTableId=${ctx.attrs.routeTableId}`,
          ),
    facts: (ctx) => [
      {
        label: "route table id",
        value: ctx.attrs?.routeTableId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.routeTableArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "associations", value: ctx.attrs?.associations?.length },
    ],
  },
);

export const RouteUI = UIProvider.succeed<Route>("AWS.EC2.Route", {
  displayName: "Route",
  icon: "route",
  color: NETWORK_PURPLE,
  category: "network",
  summary: (ctx) =>
    ctx.attrs?.destinationCidrBlock ??
    ctx.attrs?.destinationIpv6CidrBlock ??
    ctx.attrs?.destinationPrefixListId,
  facts: (ctx) => [
    {
      label: "destination",
      value:
        ctx.attrs?.destinationCidrBlock ??
        ctx.attrs?.destinationIpv6CidrBlock ??
        ctx.attrs?.destinationPrefixListId,
      mono: true,
    },
    {
      label: "target",
      value:
        ctx.attrs?.gatewayId ??
        ctx.attrs?.natGatewayId ??
        ctx.attrs?.instanceId ??
        ctx.attrs?.networkInterfaceId ??
        ctx.attrs?.vpcPeeringConnectionId ??
        ctx.attrs?.transitGatewayId ??
        ctx.attrs?.localGatewayId ??
        ctx.attrs?.carrierGatewayId,
      mono: true,
    },
    { label: "route table", value: ctx.attrs?.routeTableId, mono: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "origin", value: ctx.attrs?.origin },
  ],
});

export const RouteTableAssociationUI =
  UIProvider.succeed<RouteTableAssociation>("AWS.EC2.RouteTableAssociation", {
    displayName: "Route Table Association",
    icon: "link",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.associationId,
    facts: (ctx) => [
      {
        label: "association id",
        value: ctx.attrs?.associationId,
        mono: true,
        copy: true,
      },
      { label: "route table", value: ctx.attrs?.routeTableId, mono: true },
      { label: "subnet", value: ctx.attrs?.subnetId, mono: true },
      { label: "gateway", value: ctx.attrs?.gatewayId, mono: true },
      { label: "state", value: ctx.attrs?.associationState?.state },
    ],
  });

export const NetworkAclUI = UIProvider.succeed<NetworkAcl>(
  "AWS.EC2.NetworkAcl",
  {
    displayName: "Network ACL",
    icon: "list-checks",
    color: NETWORK_PURPLE,
    category: "security",
    summary: (ctx) => ctx.attrs?.networkAclId,
    consoleUrl: (ctx) =>
      ctx.attrs?.networkAclId === undefined
        ? undefined
        : vpcConsole(
            regionOfArn(ctx.attrs?.networkAclArn),
            `NetworkAclDetails:networkAclId=${ctx.attrs.networkAclId}`,
          ),
    facts: (ctx) => [
      {
        label: "acl id",
        value: ctx.attrs?.networkAclId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.networkAclArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "default", value: ctx.attrs?.isDefault },
      { label: "entries", value: ctx.attrs?.entries?.length },
      { label: "associations", value: ctx.attrs?.associations?.length },
    ],
  },
);

export const NetworkAclEntryUI = UIProvider.succeed<NetworkAclEntry>(
  "AWS.EC2.NetworkAclEntry",
  {
    displayName: "Network ACL Entry",
    icon: "list-plus",
    color: NETWORK_PURPLE,
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.ruleNumber === undefined
        ? undefined
        : `rule ${ctx.attrs.ruleNumber} (${ctx.attrs.egress ? "egress" : "ingress"})`,
    facts: (ctx) => [
      { label: "acl", value: ctx.attrs?.networkAclId, mono: true },
      { label: "rule number", value: ctx.attrs?.ruleNumber },
      { label: "action", value: ctx.attrs?.ruleAction },
      {
        label: "direction",
        value:
          ctx.attrs?.egress === undefined
            ? undefined
            : ctx.attrs.egress
              ? "egress"
              : "ingress",
      },
      { label: "protocol", value: ctx.attrs?.protocol },
      {
        label: "cidr",
        value: ctx.attrs?.cidrBlock ?? ctx.attrs?.ipv6CidrBlock,
        mono: true,
      },
      {
        label: "ports",
        value:
          ctx.attrs?.portRange?.from === undefined
            ? undefined
            : ctx.attrs.portRange.from === ctx.attrs.portRange.to
              ? ctx.attrs.portRange.from
              : `${ctx.attrs.portRange.from}-${ctx.attrs.portRange.to}`,
      },
    ],
  },
);

export const NetworkAclAssociationUI =
  UIProvider.succeed<NetworkAclAssociation>("AWS.EC2.NetworkAclAssociation", {
    displayName: "Network ACL Association",
    icon: "link-2",
    color: NETWORK_PURPLE,
    category: "security",
    summary: (ctx) => ctx.attrs?.associationId,
    facts: (ctx) => [
      {
        label: "association id",
        value: ctx.attrs?.associationId,
        mono: true,
        copy: true,
      },
      { label: "acl", value: ctx.attrs?.networkAclId, mono: true },
      { label: "subnet", value: ctx.attrs?.subnetId, mono: true },
    ],
  });

export const VpcEndpointUI = UIProvider.succeed<VpcEndpoint>(
  "AWS.EC2.VpcEndpoint",
  {
    displayName: "VPC Endpoint",
    icon: "plug",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.serviceName ?? ctx.attrs?.vpcEndpointId,
    consoleUrl: (ctx) =>
      ctx.attrs?.vpcEndpointId === undefined
        ? undefined
        : vpcConsole(
            regionOfArn(ctx.attrs?.vpcEndpointArn),
            `EndpointDetails:vpcEndpointId=${ctx.attrs.vpcEndpointId}`,
          ),
    facts: (ctx) => [
      {
        label: "endpoint id",
        value: ctx.attrs?.vpcEndpointId,
        mono: true,
        copy: true,
      },
      { label: "service", value: ctx.attrs?.serviceName, mono: true },
      { label: "type", value: ctx.attrs?.vpcEndpointType },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "state", value: ctx.attrs?.state },
      { label: "private dns", value: ctx.attrs?.privateDnsEnabled },
    ],
  },
);

export const DhcpOptionsUI = UIProvider.succeed<DhcpOptions>(
  "AWS.EC2.DhcpOptions",
  {
    displayName: "DHCP Options Set",
    icon: "settings",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.dhcpOptionsId,
    consoleUrl: (ctx) =>
      ctx.attrs?.dhcpOptionsId === undefined
        ? undefined
        : vpcConsole(
            regionOfArn(ctx.attrs?.dhcpOptionsArn),
            `DhcpOptionsDetails:DhcpOptionsId=${ctx.attrs.dhcpOptionsId}`,
          ),
    facts: (ctx) => [
      {
        label: "dhcp options id",
        value: ctx.attrs?.dhcpOptionsId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.dhcpOptionsArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "owner", value: ctx.attrs?.ownerId, mono: true },
      { label: "domain name", value: ctx.props?.domainName },
    ],
  },
);

export const FlowLogUI = UIProvider.succeed<FlowLog>("AWS.EC2.FlowLog", {
  displayName: "VPC Flow Log",
  icon: "activity",
  color: NETWORK_PURPLE,
  category: "observability",
  summary: (ctx) => ctx.attrs?.resourceId,
  facts: (ctx) => [
    {
      label: "flow log id",
      value: ctx.attrs?.flowLogId,
      mono: true,
      copy: true,
    },
    { label: "arn", value: ctx.attrs?.flowLogArn, mono: true, copy: true },
    { label: "resource", value: ctx.attrs?.resourceId, mono: true },
    { label: "traffic type", value: ctx.attrs?.trafficType },
    { label: "destination", value: ctx.attrs?.logDestinationType },
    { label: "log group", value: ctx.props?.logGroupName, mono: true },
  ],
});

export const NetworkInterfaceUI = UIProvider.succeed<NetworkInterface>(
  "AWS.EC2.NetworkInterface",
  {
    displayName: "Network Interface",
    icon: "cable",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.privateIpAddress ?? ctx.attrs?.networkInterfaceId,
    facts: (ctx) => [
      {
        label: "interface id",
        value: ctx.attrs?.networkInterfaceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.networkInterfaceArn,
        mono: true,
        copy: true,
      },
      { label: "subnet", value: ctx.attrs?.subnetId, mono: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "private ip", value: ctx.attrs?.privateIpAddress, mono: true },
      { label: "mac address", value: ctx.attrs?.macAddress, mono: true },
    ],
  },
);

export const NetworkInterfaceAttachmentUI =
  UIProvider.succeed<NetworkInterfaceAttachment>(
    "AWS.EC2.NetworkInterfaceAttachment",
    {
      displayName: "Network Interface Attachment",
      icon: "link",
      color: NETWORK_PURPLE,
      category: "network",
      summary: (ctx) => ctx.attrs?.attachmentId,
      facts: (ctx) => [
        {
          label: "attachment id",
          value: ctx.attrs?.attachmentId,
          mono: true,
          copy: true,
        },
        {
          label: "interface",
          value: ctx.attrs?.networkInterfaceId,
          mono: true,
        },
        { label: "instance", value: ctx.attrs?.instanceId, mono: true },
        { label: "device index", value: ctx.attrs?.deviceIndex },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const PrefixListUI = UIProvider.succeed<PrefixList>(
  "AWS.EC2.PrefixList",
  {
    displayName: "Managed Prefix List",
    icon: "list-ordered",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.prefixListName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.prefixListName, copy: true },
      {
        label: "prefix list id",
        value: ctx.attrs?.prefixListId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.prefixListArn, mono: true, copy: true },
      { label: "address family", value: ctx.attrs?.addressFamily },
      { label: "max entries", value: ctx.attrs?.maxEntries },
      { label: "version", value: ctx.attrs?.version },
    ],
  },
);

export const SnapshotUI = UIProvider.succeed<Snapshot>("AWS.EC2.Snapshot", {
  displayName: "EBS Snapshot",
  icon: "archive",
  color: STORAGE_GREEN,
  category: "storage",
  summary: (ctx) => ctx.attrs?.snapshotId,
  facts: (ctx) => [
    {
      label: "snapshot id",
      value: ctx.attrs?.snapshotId,
      mono: true,
      copy: true,
    },
    { label: "arn", value: ctx.attrs?.snapshotArn, mono: true, copy: true },
    { label: "volume", value: ctx.attrs?.volumeId, mono: true },
    { label: "size (gib)", value: ctx.attrs?.volumeSize },
    { label: "state", value: ctx.attrs?.state },
    { label: "progress", value: ctx.attrs?.progress },
    { label: "encrypted", value: ctx.attrs?.encrypted },
  ],
});

export const VolumeUI = UIProvider.succeed<Volume>("AWS.EC2.Volume", {
  displayName: "EBS Volume",
  icon: "hard-drive",
  color: STORAGE_GREEN,
  category: "storage",
  summary: (ctx) => ctx.attrs?.volumeId,
  facts: (ctx) => [
    { label: "volume id", value: ctx.attrs?.volumeId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.volumeArn, mono: true, copy: true },
    { label: "az", value: ctx.attrs?.availabilityZone },
    { label: "size (gib)", value: ctx.attrs?.size },
    { label: "type", value: ctx.attrs?.volumeType },
    { label: "state", value: ctx.attrs?.state },
    { label: "iops", value: ctx.attrs?.iops },
    { label: "encrypted", value: ctx.attrs?.encrypted },
  ],
});

export const VolumeAttachmentUI = UIProvider.succeed<VolumeAttachment>(
  "AWS.EC2.VolumeAttachment",
  {
    displayName: "EBS Volume Attachment",
    icon: "link",
    color: STORAGE_GREEN,
    category: "storage",
    summary: (ctx) => ctx.attrs?.device,
    facts: (ctx) => [
      { label: "volume", value: ctx.attrs?.volumeId, mono: true, copy: true },
      { label: "instance", value: ctx.attrs?.instanceId, mono: true },
      { label: "device", value: ctx.attrs?.device, mono: true },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const VpcPeeringConnectionUI = UIProvider.succeed<VpcPeeringConnection>(
  "AWS.EC2.VpcPeeringConnection",
  {
    displayName: "VPC Peering Connection",
    icon: "share-2",
    color: NETWORK_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.vpcPeeringConnectionId,
    facts: (ctx) => [
      {
        label: "connection id",
        value: ctx.attrs?.vpcPeeringConnectionId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "requester vpc", value: ctx.attrs?.requesterVpcId, mono: true },
      { label: "accepter vpc", value: ctx.attrs?.accepterVpcId, mono: true },
      {
        label: "accepter owner",
        value: ctx.attrs?.accepterOwnerId,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    VpcUI,
    SubnetUI,
    InstanceUI,
    SecurityGroupUI,
    SecurityGroupRuleUI,
    KeyPairUI,
    EIPUI,
    InternetGatewayUI,
    EgressOnlyInternetGatewayUI,
    NatGatewayUI,
    RouteTableUI,
    RouteUI,
    RouteTableAssociationUI,
    NetworkAclUI,
    NetworkAclEntryUI,
    NetworkAclAssociationUI,
    VpcEndpointUI,
    DhcpOptionsUI,
    FlowLogUI,
    NetworkInterfaceUI,
    NetworkInterfaceAttachmentUI,
    PrefixListUI,
    SnapshotUI,
    VolumeUI,
    VolumeAttachmentUI,
    VpcPeeringConnectionUI,
  );
