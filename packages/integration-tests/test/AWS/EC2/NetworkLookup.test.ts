import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:ec2", "live"];

// Every target carries the same per-stage `Name` tag, so a lookup by name
// finds exactly the one of its type. The two `twin` groups share another
// name, so a lookup by it is ambiguous.
const name = testName("alchemy-lookup");
const twinName = testName("alchemy-lookup-twin");

// The targets belong to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "Ec2LookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const Name = { Name: name };
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.42.0.0/16", tags: Name });
    const peer = yield* AWS.EC2.Vpc("lookup-peer-vpc", { cidrBlock: "10.43.0.0/16" });
    const subnet = yield* AWS.EC2.Subnet("lookup-subnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.42.1.0/24",
      tags: Name,
    });
    const group = yield* AWS.EC2.SecurityGroup("lookup-sg", {
      vpcId: vpc.vpcId,
      groupName: name,
      description: "lookup target",
      tags: Name,
    });
    for (const twin of ["lookup-twin-a", "lookup-twin-b"]) {
      yield* AWS.EC2.SecurityGroup(twin, {
        vpcId: vpc.vpcId,
        description: "lookup twin",
        tags: { Name: twinName },
      });
    }
    const igw = yield* AWS.EC2.InternetGateway("lookup-igw", { vpcId: vpc.vpcId, tags: Name });
    const eigw = yield* AWS.EC2.EgressOnlyInternetGateway("lookup-eigw", {
      vpcId: vpc.vpcId,
      tags: Name,
    });
    const table = yield* AWS.EC2.RouteTable("lookup-rt", { vpcId: vpc.vpcId, tags: Name });
    const acl = yield* AWS.EC2.NetworkAcl("lookup-acl", { vpcId: vpc.vpcId, tags: Name });
    const endpoint = yield* AWS.EC2.VpcEndpoint("lookup-endpoint", {
      vpcId: vpc.vpcId,
      serviceName: `com.amazonaws.${region}.s3`,
      vpcEndpointType: "Gateway",
      routeTableIds: [table.routeTableId],
      tags: Name,
    });
    const prefixList = yield* AWS.EC2.PrefixList("lookup-pl", {
      prefixListName: name,
      addressFamily: "IPv4",
      maxEntries: 1,
      entries: [{ cidr: "10.0.0.0/8" }],
      tags: Name,
    });
    const dhcp = yield* AWS.EC2.DhcpOptions("lookup-dhcp", {
      domainNameServers: ["AmazonProvidedDNS"],
      tags: Name,
    });
    const eip = yield* AWS.EC2.EIP("lookup-eip", { tags: Name });
    const eni = yield* AWS.EC2.NetworkInterface("lookup-eni", {
      subnetId: subnet.subnetId,
      tags: Name,
    });
    const volume = yield* AWS.EC2.Volume("lookup-volume", {
      availabilityZone: subnet.availabilityZone,
      size: 1,
      tags: Name,
    });
    const snapshot = yield* AWS.EC2.Snapshot("lookup-snapshot", {
      volumeId: volume.volumeId,
      tags: Name,
    });
    const key = yield* AWS.EC2.KeyPair("lookup-key", { keyName: name });
    const peering = yield* AWS.EC2.VpcPeeringConnection("lookup-peering", {
      vpcId: vpc.vpcId,
      peerVpcId: peer.vpcId,
      autoAccept: true,
      tags: Name,
    });
    return {
      region: region as string,
      vpcId: vpc.vpcId.as<string>(),
      vpcCidr: vpc.cidrBlock.as<string>(),
      subnetId: subnet.subnetId.as<string>(),
      groupId: group.groupId.as<string>(),
      igwId: igw.internetGatewayId.as<string>(),
      eigwId: eigw.egressOnlyInternetGatewayId.as<string>(),
      routeTableId: table.routeTableId.as<string>(),
      aclId: acl.networkAclId.as<string>(),
      endpointId: endpoint.vpcEndpointId.as<string>(),
      prefixListId: prefixList.prefixListId.as<string>(),
      dhcpId: dhcp.dhcpOptionsId.as<string>(),
      allocationId: eip.allocationId.as<string>(),
      publicIp: eip.publicIp.as<string>(),
      eniId: eni.networkInterfaceId.as<string>(),
      volumeId: volume.volumeId.as<string>(),
      snapshotId: snapshot.snapshotId.as<string>(),
      keyPairId: key.keyPairId.as<string>(),
      peeringId: peering.vpcPeeringConnectionId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack), { timeout: 600_000 });

test.provider(
  "VPCs, subnets and security groups resolve by id and by Name tag, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const t = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => ({
          vpcByName: AWS.EC2.Vpc.lookup({ name }).vpcId,
          vpcCidr: AWS.EC2.Vpc.lookup({ vpcId: t.vpcId }).cidrBlock,
          subnetByName: AWS.EC2.Subnet.lookup({ name }).subnetId,
          subnetVpc: AWS.EC2.Subnet.lookup({ subnetId: t.subnetId }).vpcId,
          groupByName: AWS.EC2.SecurityGroup.lookup({ name }).groupId,
          groupByVpc: AWS.EC2.SecurityGroup.lookup({ vpcId: t.vpcId, groupName: name }).groupId,
          groupVpc: AWS.EC2.SecurityGroup.lookup({ groupId: t.groupId }).vpcId,
        }),
        {
          vpcByName: t.vpcId,
          vpcCidr: t.vpcCidr,
          subnetByName: t.subnetId,
          subnetVpc: t.vpcId,
          groupByName: t.groupId,
          groupByVpc: t.groupId,
          groupVpc: t.vpcId,
        },
      );
      const { Vpcs } = yield* ec2.describeVpcs({ VpcIds: [t.vpcId] });
      expect(Vpcs?.[0]?.VpcId).toBe(t.vpcId);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "gateways, route tables, ACLs and endpoints resolve by id, Name tag and VPC",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const t = yield* target;
      const main = (yield* ec2.describeRouteTables({
        Filters: [
          { Name: "vpc-id", Values: [t.vpcId] },
          { Name: "association.main", Values: ["true"] },
        ],
      })).RouteTables?.[0]?.RouteTableId;
      const defaultAcl = (yield* ec2.describeNetworkAcls({
        Filters: [
          { Name: "vpc-id", Values: [t.vpcId] },
          { Name: "default", Values: ["true"] },
        ],
      })).NetworkAcls?.[0]?.NetworkAclId;
      yield* expectLookupConsumers(
        stack,
        () => ({
          igwByName: AWS.EC2.InternetGateway.lookup({ name }).internetGatewayId,
          igwByVpc: AWS.EC2.InternetGateway.lookup({ vpcId: t.vpcId }).internetGatewayId,
          igwById: AWS.EC2.InternetGateway.lookup({ internetGatewayId: t.igwId }).internetGatewayId,
          eigwByName: AWS.EC2.EgressOnlyInternetGateway.lookup({ name })
            .egressOnlyInternetGatewayId,
          tableByName: AWS.EC2.RouteTable.lookup({ name }).routeTableId,
          tableById: AWS.EC2.RouteTable.lookup({ routeTableId: t.routeTableId }).vpcId,
          mainTable: AWS.EC2.RouteTable.lookup({ vpcId: t.vpcId, main: true }).routeTableId,
          aclByName: AWS.EC2.NetworkAcl.lookup({ name }).networkAclId,
          defaultAcl: AWS.EC2.NetworkAcl.lookup({ vpcId: t.vpcId, isDefault: true }).networkAclId,
          endpointByName: AWS.EC2.VpcEndpoint.lookup({ name }).vpcEndpointId,
          endpointByService: AWS.EC2.VpcEndpoint.lookup({
            vpcId: t.vpcId,
            serviceName: `com.amazonaws.${t.region}.s3`,
          }).vpcEndpointId,
          peeringByName: AWS.EC2.VpcPeeringConnection.lookup({ name }).vpcPeeringConnectionId,
        }),
        {
          igwByName: t.igwId,
          igwByVpc: t.igwId,
          igwById: t.igwId,
          eigwByName: t.eigwId,
          tableByName: t.routeTableId,
          tableById: t.vpcId,
          mainTable: main!,
          aclByName: t.aclId,
          defaultAcl: defaultAcl!,
          endpointByName: t.endpointId,
          endpointByService: t.endpointId,
          peeringByName: t.peeringId,
        },
      );
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "prefix lists, DHCP options, addresses, interfaces, volumes, snapshots and key pairs resolve",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const t = yield* target;
      const s3List = (yield* ec2.describeManagedPrefixLists({
        Filters: [{ Name: "prefix-list-name", Values: [`com.amazonaws.${t.region}.s3`] }],
      })).PrefixLists?.[0]?.PrefixListId;
      yield* expectLookupConsumers(
        stack,
        () => ({
          listByName: AWS.EC2.PrefixList.lookup({ prefixListName: name }).prefixListId,
          awsList: AWS.EC2.PrefixList.lookup({ prefixListName: `com.amazonaws.${t.region}.s3` })
            .prefixListId,
          dhcpByName: AWS.EC2.DhcpOptions.lookup({ name }).dhcpOptionsId,
          eipByIp: AWS.EC2.EIP.lookup({ publicIp: t.publicIp }).allocationId,
          eipByName: AWS.EC2.EIP.lookup({ name }).publicIp,
          eniByName: AWS.EC2.NetworkInterface.lookup({ name }).networkInterfaceId,
          eniSubnet: AWS.EC2.NetworkInterface.lookup({ networkInterfaceId: t.eniId }).subnetId,
          volumeByName: AWS.EC2.Volume.lookup({ name }).volumeId,
          snapshotByName: AWS.EC2.Snapshot.lookup({ name }).snapshotId,
          snapshotVolume: AWS.EC2.Snapshot.lookup({ snapshotId: t.snapshotId }).volumeId,
          keyByName: AWS.EC2.KeyPair.lookup({ keyName: name }).keyPairId,
          keyById: AWS.EC2.KeyPair.lookup({ keyPairId: t.keyPairId }).keyName,
        }),
        {
          listByName: t.prefixListId,
          awsList: s3List!,
          dhcpByName: t.dhcpId,
          eipByIp: t.allocationId,
          eipByName: t.publicIp,
          eniByName: t.eniId,
          eniSubnet: t.subnetId,
          volumeByName: t.volumeId,
          snapshotByName: t.snapshotId,
          snapshotVolume: t.volumeId,
          keyByName: t.keyPairId,
          keyById: name,
        },
      );
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "the default VPC resolves with isDefault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { Vpcs } = yield* ec2.describeVpcs({
        Filters: [{ Name: "isDefault", Values: ["true"] }],
      });
      const defaultVpc = Vpcs?.[0]?.VpcId;
      expect(defaultVpc).toBeTruthy();
      yield* expectLookupConsumers(
        stack,
        () => ({ vpc: AWS.EC2.Vpc.lookup({ isDefault: true }).vpcId }),
        { vpc: defaultVpc! },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup by a Name tag several resources carry fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* target;
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("ambiguous-group", {
            value: AWS.EC2.SecurityGroup.lookup({ name: twinName }).groupId,
          }),
        ),
        ["AmbiguousLookupError", twinName],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing VPC, subnet, security group or address fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const missing = missingName(stack.stage);
      const lookups = {
        "missing-vpc": AWS.EC2.Vpc.lookup({ name: missing }).vpcId,
        "missing-vpc-id": AWS.EC2.Vpc.lookup({ vpcId: "vpc-00000000000000000" }).vpcId,
        "missing-subnet": AWS.EC2.Subnet.lookup({ name: missing }).subnetId,
        "missing-group": AWS.EC2.SecurityGroup.lookup({ name: missing }).groupId,
        "missing-eip": AWS.EC2.EIP.lookup({ publicIp: "192.0.2.1" }).allocationId,
        "missing-key": AWS.EC2.KeyPair.lookup({ keyName: missing }).keyPairId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a VPC this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.EC2.Vpc("lookup-managed", { cidrBlock: "10.44.0.0/16" });
      const { vpcId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-vpc-consumer", {
              value: AWS.EC2.Vpc.lookup({ vpcId }).vpcId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

// A NAT gateway takes minutes to create and delete, so it has its own target,
// skipped by `--fast`. A private one needs no internet gateway or address.
const NatTargetStack = Alchemy.Stack(
  "NatLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const vpc = yield* AWS.EC2.Vpc("lookup-nat-vpc", { cidrBlock: "10.45.0.0/16" });
    const subnet = yield* AWS.EC2.Subnet("lookup-nat-subnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.45.1.0/24",
    });
    const nat = yield* AWS.EC2.NatGateway("lookup-nat", {
      subnetId: subnet.subnetId,
      connectivityType: "private",
      tags: { Name: name },
    });
    return { natGatewayId: nat.natGatewayId.as<string>(), vpcId: vpc.vpcId.as<string>() };
  }),
);

const fast = !!process.env.FAST;
const natTarget = beforeAll(
  fast ? Effect.succeed({ natGatewayId: "", vpcId: "" }) : deploy(NatTargetStack),
  { timeout: 600_000 },
);
afterAll.skipIf(fast || !!process.env.NO_DESTROY)(destroy(NatTargetStack), { timeout: 600_000 });

test.provider.skipIf(fast)(
  "a looked-up NAT gateway resolves by id and by Name tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { natGatewayId, vpcId } = yield* natTarget;
      yield* expectLookupConsumers(
        stack,
        () => ({
          byName: AWS.EC2.NatGateway.lookup({ name }).natGatewayId,
          vpc: AWS.EC2.NatGateway.lookup({ natGatewayId }).vpcId,
        }),
        { byName: natGatewayId, vpc: vpcId },
      );
    }),
  { tags, timeout: 120_000 },
);
