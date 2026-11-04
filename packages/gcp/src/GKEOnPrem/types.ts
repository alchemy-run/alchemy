export type ClusterUser = {
  /** Principal granted cluster-admin (user clusters) or cluster-view (admin). */
  username?: string | undefined;
};

export type Authorization = {
  /** Users granted bootstrap RBAC on the cluster. */
  adminUsers?: ClusterUser[] | undefined;
};

export type BinaryAuthorization = {
  /**
   * Binauthz evaluation mode (`DISABLED`,
   * `PROJECT_SINGLETON_POLICY_ENFORCE`).
   */
  evaluationMode?: string | undefined;
};

export type NodeTaint = {
  /** Taint effect (`NO_SCHEDULE`, `PREFER_NO_SCHEDULE`, `NO_EXECUTE`). */
  effect?: string | undefined;
  /** Taint key. */
  key?: string | undefined;
  /** Taint value. */
  value?: string | undefined;
};

export type BareMetalNodeConfig = {
  /** Node IPv4 used for SSH and Kubernetes. */
  nodeIp?: string | undefined;
  /** Kubernetes labels applied to this node. */
  labels?: Record<string, string | undefined> | undefined;
};

export type BareMetalKubeletConfig = {
  /** Registry pull QPS limit. `0` means unlimited. */
  registryPullQps?: number | undefined;
  /** Burst size for registry pulls. */
  registryBurst?: number | undefined;
  /** When true, kubelet pulls one image at a time. */
  serializeImagePullsDisabled?: boolean | undefined;
};

export type BareMetalNodePoolConfig = {
  /** Kubernetes labels applied to every node in the pool. */
  labels?: Record<string, string | undefined> | undefined;
  /** Machine addresses that make up the pool. Required on create. */
  nodeConfigs?: BareMetalNodeConfig[] | undefined;
  /** Modifiable kubelet settings. */
  kubeletConfig?: BareMetalKubeletConfig | undefined;
  /** Node OS (`LINUX`). */
  operatingSystem?: string | undefined;
  /** Initial taints assigned to nodes of this pool. */
  taints?: NodeTaint[] | undefined;
};

export type BareMetalControlPlaneNodePoolConfig = {
  /** Node pool that runs the control plane. */
  nodePoolConfig?: BareMetalNodePoolConfig | undefined;
};

export type BareMetalApiServerArgument = {
  /** API server flag name without leading dashes. */
  argument?: string | undefined;
  /** Flag value passed on the command line. */
  value?: string | undefined;
};

export type BareMetalControlPlaneConfig = {
  /** Control plane node pool. Required on create. */
  controlPlaneNodePoolConfig?: BareMetalControlPlaneNodePoolConfig | undefined;
  /** Extra kube-apiserver arguments. */
  apiServerArgs?: BareMetalApiServerArgument[] | undefined;
};

export type BareMetalSecurityConfig = {
  /** Bootstrap RBAC users. */
  authorization?: Authorization;
};

export type BareMetalProxyConfig = {
  /** Proxy URI (`http://proxy.example.com`). Credentials are rejected. */
  uri?: string;
  /** Hosts that skip the proxy. */
  noProxy?: string[];
};

export type BareMetalClusterUpgradePolicy = {
  /** Upgrade policy (`SERIAL`, `CONCURRENT`). */
  policy?: string;
  /** Output-only pause flag. */
  pause?: boolean;
};

export type BareMetalLvpConfig = {
  /** Host path used for local persistent volumes. */
  path?: string | undefined;
  /** StorageClass name created for those volumes. */
  storageClass?: string | undefined;
};

export type BareMetalLvpShareConfig = {
  /** Shared-filesystem LVP path and StorageClass. */
  lvpConfig?: BareMetalLvpConfig | undefined;
  /** Number of subdirectories created under the share path. */
  sharedPathPvCount?: number | undefined;
};

export type BareMetalStorageConfig = {
  /** Local PVs backed by subdirectories of a shared filesystem. */
  lvpShareConfig?: BareMetalLvpShareConfig | undefined;
  /** Local PVs backed by mounted node disks. */
  lvpNodeMountsConfig?: BareMetalLvpConfig | undefined;
};

export type BareMetalNodeAccessConfig = {
  /** SSH login user. Defaults to `root`. */
  loginUser?: string;
};

export type BareMetalIslandModeCidrConfig = {
  /** Service CIDR blocks (RFC1918). Mutable from 1.15. */
  serviceAddressCidrBlocks?: string[] | undefined;
  /** Pod CIDR blocks (RFC1918). Immutable after create. */
  podAddressCidrBlocks?: string[] | undefined;
};

export type BareMetalSrIovConfig = {
  /** Install the SR-IOV operator. */
  enabled?: boolean | undefined;
};

export type BareMetalMultipleNetworkInterfacesConfig = {
  /** Enable multiple network interfaces for pods. */
  enabled?: boolean | undefined;
};

export type BareMetalNetworkConfig = {
  /** Island-mode pod and service CIDRs. */
  islandModeCidr?: BareMetalIslandModeCidrConfig | undefined;
  /** SR-IOV operator config. */
  srIovConfig?: BareMetalSrIovConfig | undefined;
  /** Enable advanced Anthos networking features. */
  advancedNetworking?: boolean | undefined;
  /** Multiple network interfaces. */
  multipleNetworkInterfacesConfig?: BareMetalMultipleNetworkInterfacesConfig | undefined;
};

export type BareMetalMaintenanceConfig = {
  /** CIDRs whose nodes are cordoned and drained. */
  maintenanceAddressCidrBlocks?: string[];
};

export type BareMetalWorkloadNodeConfig = {
  /** Max pods per node (drives the node CIDR size). */
  maxPodsPerNode?: string;
  /** Container runtime (`CONTAINERD`). */
  containerRuntime?: string;
};

export type BareMetalVipConfig = {
  /** VIP reserved for the Kubernetes API. */
  controlPlaneVip?: string | undefined;
  /** VIP reserved for ingress. */
  ingressVip?: string | undefined;
};

export type BareMetalLoadBalancerAddressPool = {
  /** Address pool name. */
  pool?: string | undefined;
  /** CIDRs or ranges in the pool. */
  addresses?: string[] | undefined;
  /** Avoid IPs ending in `.0` or `.255`. */
  avoidBuggyIps?: boolean | undefined;
  /** Disable automatic assignment from this pool. */
  manualAssign?: boolean | undefined;
};

export type BareMetalLoadBalancerNodePoolConfig = {
  /** Node pool that runs the load balancer. */
  nodePoolConfig?: BareMetalNodePoolConfig | undefined;
};

export type BareMetalMetalLbConfig = {
  /** Non-overlapping address pools. Ingress VIP must be included. */
  addressPools?: BareMetalLoadBalancerAddressPool[] | undefined;
  /** Load balancer node pool. Defaults to the control plane pool. */
  loadBalancerNodePoolConfig?: BareMetalLoadBalancerNodePoolConfig | undefined;
};

export type BareMetalPortConfig = {
  /** Port the control plane load balancer listens on. */
  controlPlaneLoadBalancerPort?: number | undefined;
};

export type BareMetalManualLbConfig = {
  /** Enable manual load balancing. */
  enabled?: boolean | undefined;
};

export type BareMetalBgpPeerConfig = {
  /** Control plane node IPs that peer with the external device. */
  controlPlaneNodes?: string[] | undefined;
  /** Peer ASN. */
  asn?: string | undefined;
  /** Peer IP address. */
  ipAddress?: string | undefined;
};

export type BareMetalBgpLbConfig = {
  /** Load balancer node pool. Defaults to the control plane pool. */
  loadBalancerNodePoolConfig?: BareMetalLoadBalancerNodePoolConfig | undefined;
  /** Cluster ASN. Mutable after create. */
  asn?: string | undefined;
  /** Non-overlapping address pools. */
  addressPools?: BareMetalLoadBalancerAddressPool[] | undefined;
  /** BGP peers advertised by control plane nodes. */
  bgpPeerConfigs?: BareMetalBgpPeerConfig[] | undefined;
};

export type BareMetalLoadBalancerConfig = {
  /** Control plane and ingress VIPs. */
  vipConfig?: BareMetalVipConfig | undefined;
  /** MetalLB configuration. */
  metalLbConfig?: BareMetalMetalLbConfig | undefined;
  /** Load balancer listen ports. */
  portConfig?: BareMetalPortConfig | undefined;
  /** Manual load balancer. */
  manualLbConfig?: BareMetalManualLbConfig | undefined;
  /** BGP load balancer. Implies advanced networking. */
  bgpLbConfig?: BareMetalBgpLbConfig | undefined;
};

export type BareMetalClusterOperationsConfig = {
  /** Collect application logs and metrics in addition to system ones. */
  enableApplicationLogs?: boolean;
};

export type BareMetalOsEnvironmentConfig = {
  /** Skip adding the package repo when initializing machines. */
  packageRepoExcluded?: boolean;
};

export type BareMetalParallelUpgradeConfig = {
  /** Minimum healthy nodes during an upgrade. */
  minimumAvailableNodes?: number;
  /** Maximum nodes upgraded at once. */
  concurrentNodes?: number;
};

export type BareMetalNodePoolUpgradePolicy = {
  /** Parallel upgrade settings. */
  parallelUpgradeConfig?: BareMetalParallelUpgradeConfig;
};

export type VmwareAutoResizeConfig = {
  /** Enable control plane node auto-resizing. */
  enabled?: boolean | undefined;
};

export type VmwareControlPlaneVsphereConfig = {
  /** vSphere datastore for control plane nodes. */
  datastore?: string | undefined;
  /** vSphere storage policy for control plane nodes. */
  storagePolicyName?: string | undefined;
};

export type VmwareControlPlaneNodeConfig = {
  /** Memory in MB per control plane node. Default 8192. */
  memory?: string | undefined;
  /** Auto-resize configuration. */
  autoResizeConfig?: VmwareAutoResizeConfig | undefined;
  /** CPUs per control plane node. Default 4. */
  cpus?: string | undefined;
  /** vSphere-specific control plane settings. */
  vsphereConfig?: VmwareControlPlaneVsphereConfig | undefined;
  /** Replica count. Must be 1 or 3. Default 1. */
  replicas?: string | undefined;
};

export type VmwareStorageConfig = {
  /** Disable vSphere CSI in the user cluster. Enabled by default. */
  vsphereCsiDisabled?: boolean | undefined;
};

export type VmwareVCenterConfig = {
  /** vCenter CA certificate public key for SSL verification. */
  caCertData?: string | undefined;
  /** vCenter datastore. */
  datastore?: string | undefined;
  /** vCenter datacenter. */
  datacenter?: string | undefined;
  /** vCenter cluster. */
  cluster?: string | undefined;
  /** vCenter folder. */
  folder?: string | undefined;
  /** Output-only vCenter address. */
  address?: string | undefined;
  /** vCenter resource pool. */
  resourcePool?: string | undefined;
  /** vCenter storage policy. */
  storagePolicyName?: string | undefined;
};

export type VmwareVipConfig = {
  /** VIP reserved for the Kubernetes API. */
  controlPlaneVip?: string | undefined;
  /** VIP reserved for ingress. */
  ingressVip?: string | undefined;
};

export type VmwareF5BigIpConfig = {
  /** Pre-existing F5 partition. */
  partition?: string | undefined;
  /** SNAT pool name. */
  snatPool?: string | undefined;
  /** Load balancer IP. */
  address?: string | undefined;
};

export type VmwareManualLbConfig = {
  /** NodePort for the control plane service. */
  controlPlaneNodePort?: number | undefined;
  /** NodePort for ingress HTTP. */
  ingressHttpNodePort?: number | undefined;
  /** NodePort for ingress HTTPS. */
  ingressHttpsNodePort?: number | undefined;
  /** NodePort for the konnectivity sidecar. */
  konnectivityServerNodePort?: number | undefined;
};

export type VmwareHostIp = {
  /** IP or CIDR. */
  ip?: string | undefined;
  /** Hostname. VM name is used when empty. */
  hostname?: string | undefined;
};

export type VmwareIpBlock = {
  /** Netmask. */
  netmask?: string | undefined;
  /** Per-node IP assignments. */
  ips?: VmwareHostIp[] | undefined;
  /** Gateway. */
  gateway?: string | undefined;
};

export type VmwareSeesawConfig = {
  /** Enable a highly-available Seesaw pair. */
  enableHa?: boolean | undefined;
  /** IP blocks used by Seesaw. */
  ipBlocks?: VmwareIpBlock[] | undefined;
  /** VM names created for this Seesaw group. */
  vms?: string[] | undefined;
  /** Seesaw group name, typically `seesaw-for-{cluster}`. */
  group?: string | undefined;
  /** IP announced by the Seesaw master. */
  masterIp?: string | undefined;
  /** Stackdriver name. */
  stackdriverName?: string | undefined;
};

export type VmwareAddressPool = BareMetalLoadBalancerAddressPool;

export type VmwareMetalLbConfig = {
  /** Non-overlapping address pools. Ingress VIP must be included. */
  addressPools?: VmwareAddressPool[] | undefined;
};

export type VmwareLoadBalancerConfig = {
  /** Control plane and ingress VIPs. */
  vipConfig?: VmwareVipConfig | undefined;
  /** F5 BIG-IP configuration. */
  f5Config?: VmwareF5BigIpConfig | undefined;
  /** Manual load balancer. */
  manualLbConfig?: VmwareManualLbConfig | undefined;
  /** Output-only Seesaw configuration. */
  seesawConfig?: VmwareSeesawConfig | undefined;
  /** MetalLB configuration. */
  metalLbConfig?: VmwareMetalLbConfig | undefined;
};

export type VmwareControlPlaneV2Config = {
  /** Static IPs for control plane V2 nodes. */
  controlPlaneIpBlock?: VmwareIpBlock | undefined;
};

export type VmwareHostConfig = {
  /** NTP servers. */
  ntpServers?: string[] | undefined;
  /** DNS servers. */
  dnsServers?: string[] | undefined;
  /** DNS search domains. */
  dnsSearchDomains?: string[] | undefined;
};

export type VmwareStaticIpConfig = {
  /** Static IP blocks assigned to nodes. */
  ipBlocks?: VmwareIpBlock[] | undefined;
};

export type VmwareDhcpIpConfig = {
  /** Use DHCP for node IPs. */
  enabled?: boolean | undefined;
};

export type VmwareNetworkConfig = {
  /** vCenter network name. Inherited from the admin cluster. */
  vcenterNetwork?: string | undefined;
  /** Common host network settings. */
  hostConfig?: VmwareHostConfig | undefined;
  /** Control plane V2 IP config. */
  controlPlaneV2Config?: VmwareControlPlaneV2Config | undefined;
  /** Service CIDR blocks. Single range. Immutable. */
  serviceAddressCidrBlocks?: string[] | undefined;
  /** Pod CIDR blocks. Single range. Immutable. */
  podAddressCidrBlocks?: string[] | undefined;
  /** Static IP configuration. */
  staticIpConfig?: VmwareStaticIpConfig | undefined;
  /** DHCP IP configuration. */
  dhcpIpConfig?: VmwareDhcpIpConfig | undefined;
};

export type VmwareDataplaneV2Config = {
  /** Enable Dataplane V2 on Windows nodes. */
  windowsDataplaneV2Enabled?: boolean | undefined;
  /** Enable Dataplane V2. */
  dataplaneV2Enabled?: boolean | undefined;
  /** Advanced networking. Requires Dataplane V2. */
  advancedNetworking?: boolean | undefined;
  /** Dataplane V2 forward mode. */
  forwardMode?: string | undefined;
};

export type VmwareAAGConfig = {
  /** Disable anti-affinity (spread across three hosts). Enabled by default. */
  aagConfigDisabled?: boolean | undefined;
};

export type VmwareAutoRepairConfig = {
  /** Enable auto repair. */
  enabled?: boolean | undefined;
};

export type VmwareClusterUpgradePolicy = {
  /** Restrict the upgrade to the control plane. */
  controlPlaneOnly?: boolean | undefined;
};

export type VmwareNodePoolAutoscalingConfig = {
  /** Minimum replicas. */
  minReplicas?: number;
  /** Maximum replicas. */
  maxReplicas?: number;
};

export type VmwareVsphereTag = {
  /** vSphere tag name. */
  tag?: string;
  /** vSphere tag category. */
  category?: string;
};

export type VmwareVsphereConfig = {
  /** Host groups applied to VMs in the pool. */
  hostGroups?: string[];
  /** vCenter datastore. Inherited from the user cluster. */
  datastore?: string;
  /** vSphere tags applied to VMs. */
  tags?: VmwareVsphereTag[];
};

export type VmwareNodeConfig = {
  /** Replica count. */
  replicas?: string;
  /** OS image name in vCenter (Windows only). */
  image?: string;
  /** Allow MetalLB to load-balance this pool. */
  enableLoadBalancer?: boolean;
  /**
   * OS image type (`cos`, `cos_cgv2`, `ubuntu`, `ubuntu_cgv2`,
   * `ubuntu_containerd`, `windows`).
   */
  imageType?: string;
  /** Initial taints. */
  taints?: NodeTaint[];
  /** CPUs per node. */
  cpus?: string;
  /** vSphere settings for this pool. */
  vsphereConfig?: VmwareVsphereConfig;
  /** Memory in MB per node. */
  memoryMb?: string;
  /** Boot disk size in GB. */
  bootDiskSizeGb?: string;
  /** Kubernetes labels applied to each node. */
  labels?: Record<string, string | undefined>;
};

export type Fleet = {
  /** Output-only Hub membership resource name. */
  membership?: string | undefined;
};
