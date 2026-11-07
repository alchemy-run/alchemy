import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { CERT_A_PEM, KEY_A_PEM } from "./https-proxy-cert.ts";

/**
 * One of each Compute resource the generated bindings bind, for
 * {@link ./generated-host.ts}. Each mirrors the smallest shape its own
 * resource suite deploys.
 */

const zone = "us-central1-a";
const region = "us-central1";
const DEFAULT_NETWORK = "default";
/** Load balancers and packet mirroring take a network URL, not a bare name. */
const DEFAULT_NETWORK_URL = "global/networks/default";

const redirect = {
  defaultUrlRedirect: { httpsRedirect: true, hostRedirect: "example.com", stripQuery: false },
};

const templateProps: GCP.Compute.InstanceTemplateProps = {
  machineType: "e2-micro",
  disks: [
    {
      boot: true,
      autoDelete: true,
      sourceImage: "projects/debian-cloud/global/images/family/debian-12",
      diskSizeGb: 10,
    },
  ],
  networkInterfaces: [{ network: "global/networks/default" }],
};

export const Address = GCP.Compute.Address("ProbeAddress", { region });
export const GlobalAddress = GCP.Compute.GlobalAddress("ProbeGlobalAddress", {});

export const Network = GCP.Compute.Network("ProbeVpc", { autoCreateSubnetworks: false });
export const Subnetwork = Effect.gen(function* () {
  const network = yield* Network;
  return yield* GCP.Compute.Subnetwork("ProbeSubnet", {
    network: network.networkName,
    region,
    ipCidrRange: "10.98.0.0/24",
  });
});
export const Firewall = Effect.gen(function* () {
  const network = yield* Network;
  return yield* GCP.Compute.Firewall("ProbeFirewall", {
    network: network.networkName,
    allowed: [{ protocol: "tcp", ports: ["80"] }],
    sourceRanges: ["10.0.0.0/8"],
  });
});
export const Route = GCP.Compute.Route("ProbeRoute", {
  destRange: "192.0.2.0/24",
  network: DEFAULT_NETWORK,
  nextHopGateway: "default-internet-gateway",
  tags: ["alchemy-probe"],
});
export const Router = GCP.Compute.Router("ProbeRouter", {
  network: DEFAULT_NETWORK,
  region,
  bgp: { asn: 64515 },
});
export const NetworkAttachment = Effect.gen(function* () {
  const subnet = yield* Subnetwork;
  return yield* GCP.Compute.NetworkAttachment("ProbeAttachment", {
    region,
    subnetworks: [subnet.selfLink.as<string>()],
    connectionPreference: "ACCEPT_AUTOMATIC",
  });
});
export const NetworkFirewallPolicy = GCP.Compute.NetworkFirewallPolicy("ProbeFwPolicy", {});
export const RegionNetworkFirewallPolicy = GCP.Compute.RegionNetworkFirewallPolicy(
  "ProbeRegionFwPolicy",
  { region },
);
export const ExternalVpnGateway = GCP.Compute.ExternalVpnGateway("ProbePeer", {
  redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
  interfaces: [{ id: 0, ipAddress: "15.0.0.121" }],
});
export const VpnGateway = GCP.Compute.VpnGateway("ProbeHaVpn", {
  region,
  network: DEFAULT_NETWORK,
});
export const TargetVpnGateway = GCP.Compute.TargetVpnGateway("ProbeClassicVpn", {
  region,
  network: DEFAULT_NETWORK,
});
export const VpnTunnel = Effect.gen(function* () {
  const gateway = yield* VpnGateway;
  const router = yield* Router;
  const peer = yield* ExternalVpnGateway;
  return yield* GCP.Compute.VpnTunnel("ProbeTunnel", {
    region,
    vpnGateway: gateway.vpnGatewayName,
    vpnGatewayInterface: 0,
    peerExternalGateway: peer.externalVpnGatewayName,
    peerExternalGatewayInterface: 0,
    router: router.routerName,
    sharedSecret: "alchemy-probe-shared-secret",
  });
});
export const CrossSiteNetwork = GCP.Compute.CrossSiteNetwork("ProbeCrossSite", {});

export const Disk = GCP.Compute.Disk("ProbeDisk", { zone, type: "pd-standard", sizeGb: 10 });
export const RegionDisk = GCP.Compute.RegionDisk("ProbeRegionDisk", {
  region,
  replicaZones: ["us-central1-a", "us-central1-b"],
  type: "pd-standard",
  sizeGb: 200,
});
export const Snapshot = Effect.gen(function* () {
  const disk = yield* Disk;
  return yield* GCP.Compute.Snapshot("ProbeSnapshot", {
    sourceDisk: disk.selfLink.as<string>(),
  });
});
export const RegionSnapshot = Effect.gen(function* () {
  const disk = yield* RegionDisk;
  return yield* GCP.Compute.RegionSnapshot("ProbeRegionSnapshot", {
    region,
    sourceDisk: disk.selfLink.as<string>(),
  });
});
export const InstantSnapshot = Effect.gen(function* () {
  const disk = yield* Disk;
  return yield* GCP.Compute.InstantSnapshot("ProbeInstantSnapshot", {
    zone,
    sourceDisk: disk.selfLink.as<string>(),
  });
});
export const RegionInstantSnapshot = Effect.gen(function* () {
  const disk = yield* RegionDisk;
  return yield* GCP.Compute.RegionInstantSnapshot("ProbeRegionInstantSnapshot", {
    region,
    sourceDisk: disk.selfLink.as<string>(),
  });
});
export const Image = Effect.gen(function* () {
  const disk = yield* Disk;
  return yield* GCP.Compute.Image("ProbeImage", {
    sourceDisk: disk.selfLink.as<string>(),
    storageLocations: ["us-central1"],
  });
});
export const ResourcePolicy = GCP.Compute.ResourcePolicy("ProbeSchedule", {
  region,
  snapshotSchedulePolicy: {
    schedule: { dailySchedule: { daysInCycle: 1, startTime: "04:00" } },
    retentionPolicy: { maxRetentionDays: 7 },
  },
});

export const Instance = GCP.Compute.Instance("ProbeVm", {
  zone,
  machineType: "e2-micro",
  associatePublicIp: false,
});
export const MachineImage = Effect.gen(function* () {
  const vm = yield* Instance;
  return yield* GCP.Compute.MachineImage("ProbeMachineImage", {
    sourceInstance: vm.selfLink.as<string>(),
    storageLocations: ["us-central1"],
  });
});
export const TargetInstance = Effect.gen(function* () {
  const vm = yield* Instance;
  return yield* GCP.Compute.TargetInstance("ProbeTargetInstance", {
    instance: vm.instanceName,
    zone,
  });
});
export const InstanceTemplate = GCP.Compute.InstanceTemplate("ProbeTemplate", templateProps);
export const RegionInstanceTemplate = GCP.Compute.RegionInstanceTemplate("ProbeRegionTemplate", {
  ...templateProps,
  region,
});
export const InstanceGroup = GCP.Compute.InstanceGroup("ProbeGroup", {
  zone,
  namedPorts: [{ name: "http", port: 80 }],
});
export const InstanceGroupManager = Effect.gen(function* () {
  const template = yield* InstanceTemplate;
  return yield* GCP.Compute.InstanceGroupManager("ProbeMig", {
    zone,
    instanceTemplate: template.templateName,
    targetSize: 0,
  });
});
export const RegionInstanceGroupManager = Effect.gen(function* () {
  const template = yield* InstanceTemplate;
  return yield* GCP.Compute.RegionInstanceGroupManager("ProbeRegionMig", {
    region,
    instanceTemplate: template.selfLink.as<string>(),
    baseInstanceName: "probe",
    targetSize: 0,
  });
});
export const Autoscaler = Effect.gen(function* () {
  const mig = yield* InstanceGroupManager;
  return yield* GCP.Compute.Autoscaler("ProbeScaler", {
    zone,
    target: mig.selfLink.as<string>(),
    autoscalingPolicy: { minNumReplicas: 0, maxNumReplicas: 1, mode: "OFF" },
  });
});
export const RegionAutoscaler = Effect.gen(function* () {
  const mig = yield* RegionInstanceGroupManager;
  return yield* GCP.Compute.RegionAutoscaler("ProbeRegionScaler", {
    region,
    target: mig.selfLink.as<string>(),
    autoscalingPolicy: { minNumReplicas: 0, maxNumReplicas: 1, mode: "OFF" },
  });
});
export const NetworkEndpointGroup = GCP.Compute.NetworkEndpointGroup("ProbeNeg", {
  zone,
  network: DEFAULT_NETWORK,
  defaultPort: 80,
});
export const RegionNetworkEndpointGroup = GCP.Compute.RegionNetworkEndpointGroup(
  "ProbeServerlessNeg",
  { region, networkEndpointType: "SERVERLESS", cloudRun: { urlMask: "<service>" } },
);
export const GlobalNetworkEndpointGroup = GCP.Compute.GlobalNetworkEndpointGroup(
  "ProbeInternetNeg",
  { networkEndpointType: "INTERNET_FQDN_PORT", defaultPort: 443 },
);
export const ZoneVmExtensionPolicy = GCP.Compute.ZoneVmExtensionPolicy("ProbeZoneExtensions", {
  zone,
  priority: 501,
  extensionPolicies: { "ops-agent": {} },
  instanceSelectors: [{ labelSelector: { inclusionLabels: { "alchemy-probe": "never" } } }],
});
export const GlobalVmExtensionPolicy = GCP.Compute.GlobalVmExtensionPolicy(
  "ProbeGlobalExtensions",
  {
    extensionPolicies: { "ops-agent": {} },
    rolloutOperation: { rolloutInput: { predefinedRolloutPlan: "FAST_ROLLOUT" } },
    priority: 11,
  },
);
export const RolloutPlan = GCP.Compute.RolloutPlan("ProbeRolloutPlan", {
  locationScope: "ZONAL",
  waves: [
    {
      displayName: "central",
      selectors: [{ locationSelector: { includedLocations: [zone] } }],
      validation: { type: "time", timeBasedValidationMetadata: { waitDuration: "0s" } },
    },
  ],
});
export const Reservation = GCP.Compute.Reservation("ProbeReservation", {
  zone,
  specificReservation: { count: 1, instanceProperties: { machineType: "e2-micro" } },
  specificReservationRequired: true,
});
export const License = GCP.Compute.License("ProbeLicense", { transferable: true });
export const NodeTemplate = GCP.Compute.NodeTemplate("ProbeNodeTemplate", {
  region,
  nodeType: "n2-node-80-640",
});

export const HealthCheck = GCP.Compute.HealthCheck("ProbeHealthCheck", {
  type: "TCP",
  tcpHealthCheck: { port: 80 },
});
export const HttpHealthCheck = GCP.Compute.HttpHealthCheck("ProbeHttpCheck", { port: 80 });
export const HttpsHealthCheck = GCP.Compute.HttpsHealthCheck("ProbeHttpsCheck", { port: 443 });
export const RegionHealthCheck = GCP.Compute.RegionHealthCheck("ProbeRegionCheck", {
  region,
  type: "TCP",
  tcpHealthCheck: { port: 80 },
});
export const RegionHealthAggregationPolicy = GCP.Compute.RegionHealthAggregationPolicy(
  "ProbeAggregation",
  { region },
);
export const RegionBackendService = GCP.Compute.RegionBackendService("ProbeRegionBackend", {
  region,
  protocol: "TCP",
  loadBalancingScheme: "INTERNAL_MANAGED",
});
export const RegionHealthSource = Effect.gen(function* () {
  const policy = yield* RegionHealthAggregationPolicy;
  const backend = yield* RegionBackendService;
  return yield* GCP.Compute.RegionHealthSource("ProbeHealthSource", {
    region,
    sources: [backend.selfLink.as<string>()],
    healthAggregationPolicy: policy.selfLink.as<string>(),
  });
});
export const BackendService = Effect.gen(function* () {
  const check = yield* HealthCheck;
  return yield* GCP.Compute.BackendService("ProbeBackend", {
    protocol: "TCP",
    loadBalancingScheme: "EXTERNAL",
    healthChecks: [check.selfLink.as<string>()],
  });
});
const Assets = GCP.Storage.Bucket("ProbeAssets", { location: "US-CENTRAL1", forceDestroy: true });
export const BackendBucket = Effect.gen(function* () {
  const assets = yield* Assets;
  return yield* GCP.Compute.BackendBucket("ProbeBackendBucket", { bucketName: assets.bucketName });
});
export const RegionBackendBucket = Effect.gen(function* () {
  const assets = yield* Assets;
  return yield* GCP.Compute.RegionBackendBucket("ProbeRegionBackendBucket", {
    region,
    bucketName: assets.bucketName,
  });
});
export const UrlMap = GCP.Compute.UrlMap("ProbeUrlMap", redirect);
export const RegionUrlMap = GCP.Compute.RegionUrlMap("ProbeRegionUrlMap", { region, ...redirect });
export const SslCertificate = GCP.Compute.SslCertificate("ProbeCert", {
  certificate: CERT_A_PEM,
  privateKey: KEY_A_PEM,
});
export const RegionSslCertificate = GCP.Compute.RegionSslCertificate("ProbeRegionCert", {
  region,
  certificate: CERT_A_PEM,
  privateKey: KEY_A_PEM,
});
export const SslPolicy = GCP.Compute.SslPolicy("ProbeSslPolicy", {
  profile: "MODERN",
  minTlsVersion: "TLS_1_2",
});
export const RegionSslPolicy = GCP.Compute.RegionSslPolicy("ProbeRegionSslPolicy", {
  region,
  profile: "MODERN",
  minTlsVersion: "TLS_1_2",
});
export const SecurityPolicy = GCP.Compute.SecurityPolicy("ProbeArmor", {});
export const RegionSecurityPolicy = GCP.Compute.RegionSecurityPolicy("ProbeRegionArmor", {
  region,
});
export const TargetHttpProxy = Effect.gen(function* () {
  const map = yield* UrlMap;
  return yield* GCP.Compute.TargetHttpProxy("ProbeHttpProxy", { urlMap: map.urlMapName });
});
export const TargetHttpsProxy = Effect.gen(function* () {
  const map = yield* UrlMap;
  const cert = yield* SslCertificate;
  return yield* GCP.Compute.TargetHttpsProxy("ProbeHttpsProxy", {
    urlMap: map.urlMapName,
    sslCertificates: [cert.sslCertificateName],
  });
});
export const RegionTargetHttpProxy = Effect.gen(function* () {
  const map = yield* RegionUrlMap;
  return yield* GCP.Compute.RegionTargetHttpProxy("ProbeRegionHttpProxy", {
    region,
    urlMap: map.urlMapName,
  });
});
export const RegionTargetHttpsProxy = Effect.gen(function* () {
  const map = yield* RegionUrlMap;
  const cert = yield* RegionSslCertificate;
  return yield* GCP.Compute.RegionTargetHttpsProxy("ProbeRegionHttpsProxy", {
    region,
    urlMap: map.urlMapName,
    sslCertificates: [cert.sslCertificateName],
  });
});
export const RegionTargetTcpProxy = Effect.gen(function* () {
  const backend = yield* RegionBackendService;
  return yield* GCP.Compute.RegionTargetTcpProxy("ProbeRegionTcpProxy", {
    region,
    service: backend.name,
    proxyHeader: "NONE",
  });
});
export const TargetTcpProxy = Effect.gen(function* () {
  const backend = yield* BackendService;
  return yield* GCP.Compute.TargetTcpProxy("ProbeTcpProxy", {
    service: backend.name,
    proxyHeader: "NONE",
  });
});
export const TargetSslProxy = Effect.gen(function* () {
  const check = yield* HealthCheck;
  const cert = yield* SslCertificate;
  const backend = yield* GCP.Compute.BackendService("ProbeSslBackend", {
    protocol: "SSL",
    loadBalancingScheme: "EXTERNAL",
    healthChecks: [check.selfLink.as<string>()],
  });
  return yield* GCP.Compute.TargetSslProxy("ProbeSslProxy", {
    service: backend.name,
    sslCertificates: [cert.sslCertificateName],
  });
});
export const TargetGrpcProxy = Effect.gen(function* () {
  const backend = yield* GCP.Compute.BackendService("ProbeGrpcBackend", {
    protocol: "GRPC",
    loadBalancingScheme: "INTERNAL_SELF_MANAGED",
  });
  const map = yield* GCP.Compute.UrlMap("ProbeGrpcMap", { defaultService: backend.selfLink });
  return yield* GCP.Compute.TargetGrpcProxy("ProbeGrpcProxy", { urlMap: map.urlMapName });
});
export const TargetPool = GCP.Compute.TargetPool("ProbePool", { region });
export const ForwardingRule = Effect.gen(function* () {
  const pool = yield* TargetPool;
  return yield* GCP.Compute.ForwardingRule("ProbeForwardingRule", {
    region,
    target: pool.selfLink.as<string>(),
    ipProtocol: "TCP",
    portRange: "80",
  });
});
export const GlobalForwardingRule = Effect.gen(function* () {
  const proxy = yield* TargetHttpProxy;
  return yield* GCP.Compute.GlobalForwardingRule("ProbeGlobalForwardingRule", {
    target: proxy.selfLink.as<string>(),
    portRange: "80",
    loadBalancingScheme: "EXTERNAL",
  });
});

/** An internal TCP load balancer: the producer behind a service attachment, and a mirroring collector. */
const IlbCheck = GCP.Compute.RegionHealthCheck("ProbeIlbCheck", {
  region,
  type: "TCP",
  tcpHealthCheck: { port: 80 },
});
const IlbBackend = Effect.gen(function* () {
  const check = yield* IlbCheck;
  return yield* GCP.Compute.RegionBackendService("ProbeIlbBackend", {
    region,
    protocol: "TCP",
    loadBalancingScheme: "INTERNAL",
    network: DEFAULT_NETWORK_URL,
    healthChecks: [check.selfLink.as<string>()],
  });
});
const ProducerSubnet = GCP.Compute.Subnetwork("ProbeProducerSubnet", {
  network: DEFAULT_NETWORK,
  region,
  ipCidrRange: "172.20.92.0/24",
});
const NatSubnet = GCP.Compute.Subnetwork("ProbeNatSubnet", {
  network: DEFAULT_NETWORK,
  region,
  ipCidrRange: "172.20.93.0/24",
  purpose: "PRIVATE_SERVICE_CONNECT",
});
const ProducerRule = Effect.gen(function* () {
  const backend = yield* IlbBackend;
  const subnet = yield* ProducerSubnet;
  return yield* GCP.Compute.ForwardingRule("ProbeProducerRule", {
    region,
    loadBalancingScheme: "INTERNAL",
    backendService: backend.selfLink.as<string>(),
    network: DEFAULT_NETWORK_URL,
    subnetwork: subnet.selfLink.as<string>(),
    ipProtocol: "TCP",
    allPorts: true,
  });
});
export const ServiceAttachment = Effect.gen(function* () {
  const rule = yield* ProducerRule;
  const nat = yield* NatSubnet;
  return yield* GCP.Compute.ServiceAttachment("ProbeServiceAttachment", {
    region,
    targetService: rule.selfLink.as<string>(),
    natSubnets: [nat.selfLink.as<string>()],
    connectionPreference: "ACCEPT_AUTOMATIC",
    enableProxyProtocol: false,
  });
});
const CollectorRule = Effect.gen(function* () {
  const backend = yield* GCP.Compute.RegionBackendService("ProbeCollectorBackend", {
    region,
    protocol: "TCP",
    loadBalancingScheme: "INTERNAL",
    network: DEFAULT_NETWORK_URL,
    healthChecks: [(yield* IlbCheck).selfLink.as<string>()],
  });
  return yield* GCP.Compute.ForwardingRule("ProbeCollectorRule", {
    region,
    loadBalancingScheme: "INTERNAL",
    backendService: backend.selfLink.as<string>(),
    network: DEFAULT_NETWORK_URL,
    ipProtocol: "TCP",
    allPorts: true,
    isMirroringCollector: true,
  });
});
export const PacketMirroring = Effect.gen(function* () {
  const collector = yield* CollectorRule;
  return yield* GCP.Compute.PacketMirroring("ProbeMirroring", {
    region,
    network: DEFAULT_NETWORK_URL,
    collectorIlb: collector.selfLink.as<string>(),
    mirroredResources: { tags: ["alchemy-probe-pm"] },
  });
});
const IlbSource = Effect.gen(function* () {
  const policy = yield* RegionHealthAggregationPolicy;
  const backend = yield* IlbBackend;
  return yield* GCP.Compute.RegionHealthSource("ProbeIlbSource", {
    region,
    sources: [backend.selfLink.as<string>()],
    healthAggregationPolicy: policy.selfLink.as<string>(),
  });
});
export const RegionCompositeHealthCheck = Effect.gen(function* () {
  const rule = yield* ProducerRule;
  const source = yield* IlbSource;
  return yield* GCP.Compute.RegionCompositeHealthCheck("ProbeComposite", {
    region,
    healthDestination: rule.selfLink.as<string>(),
    healthSources: [source.selfLink.as<string>()],
  });
});

/**
 * Hyperdisks in a disk consistency group, so a group snapshot has members.
 * One group per snapshot kind: a zonal snapshot group needs every disk in
 * its group zonal and in its zone, so the regional disk gets its own.
 */
const ConsistencyGroup = GCP.Compute.ResourcePolicy("ProbeConsistencyGroup", {
  region,
  diskConsistencyGroupPolicy: {},
});
const RegionConsistencyGroup = GCP.Compute.ResourcePolicy("ProbeRegionConsistencyGroup", {
  region,
  diskConsistencyGroupPolicy: {},
});
export const InstantSnapshotGroup = Effect.gen(function* () {
  const group = yield* ConsistencyGroup;
  const member = yield* GCP.Compute.Disk("ProbeGroupMember", {
    zone,
    type: "hyperdisk-balanced",
    sizeGb: 4,
    resourcePolicies: [group.selfLink.as<string>()],
  });
  return yield* GCP.Compute.InstantSnapshotGroup("ProbeSnapshotGroup", {
    zone,
    // through the member, so the group is snapshotted once the disk joined it
    sourceConsistencyGroup: Output.all(group.selfLink, member.diskName).pipe(
      Output.map(([selfLink]) => selfLink as string),
    ),
  });
});
export const RegionInstantSnapshotGroup = Effect.gen(function* () {
  const group = yield* RegionConsistencyGroup;
  const member = yield* GCP.Compute.RegionDisk("ProbeRegionGroupMember", {
    region,
    replicaZones: ["us-central1-a", "us-central1-b"],
    type: "hyperdisk-balanced-high-availability",
    sizeGb: 4,
    resourcePolicies: [group.selfLink.as<string>()],
  });
  return yield* GCP.Compute.RegionInstantSnapshotGroup("ProbeRegionSnapshotGroup", {
    region,
    // through the member, so the group is snapshotted once the disk joined it
    sourceConsistencyGroup: Output.all(group.selfLink, member.diskName).pipe(
      Output.map(([selfLink]) => selfLink as string),
    ),
  });
});

/** A sole-tenant node group with no nodes yet (nothing bills until a node is added). */
export const ProbeNodeGroup = Effect.gen(function* () {
  const template = yield* GCP.Compute.NodeTemplate("ProbeNodeTemplate", {
    region: "us-central1",
    nodeType: "n2-node-80-640",
  });
  return yield* GCP.Compute.NodeGroup("ProbeNodeGroup", {
    zone: "us-central1-a",
    nodeTemplate: template.nodeTemplateName,
    initialNodeCount: 0,
  });
});
