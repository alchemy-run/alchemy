import * as Layer from "effect/Layer";
import { Addon, AddonProvider } from "./Addon.ts";
import { CloudLink, CloudLinkProvider } from "./CloudLink.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { Datastore, DatastoreProvider } from "./Datastore.ts";
import {
  ExpressRouteAuthorization,
  ExpressRouteAuthorizationProvider,
} from "./ExpressRouteAuthorization.ts";
import {
  GlobalReachConnection,
  GlobalReachConnectionProvider,
} from "./GlobalReachConnection.ts";
import {
  HcxEnterpriseSite,
  HcxEnterpriseSiteProvider,
} from "./HcxEnterpriseSite.ts";
import { IscsiPath, IscsiPathProvider } from "./IscsiPath.ts";
import { License, LicenseProvider } from "./License.ts";
import { PlacementPolicy, PlacementPolicyProvider } from "./PlacementPolicy.ts";
import { PrivateCloud, PrivateCloudProvider } from "./PrivateCloud.ts";
import {
  PureStoragePolicy,
  PureStoragePolicyProvider,
} from "./PureStoragePolicy.ts";
import {
  WorkloadNetworkDhcp,
  WorkloadNetworkDhcpProvider,
} from "./WorkloadNetworkDhcp.ts";
import {
  WorkloadNetworkDnsService,
  WorkloadNetworkDnsServiceProvider,
} from "./WorkloadNetworkDnsService.ts";
import {
  WorkloadNetworkDnsZone,
  WorkloadNetworkDnsZoneProvider,
} from "./WorkloadNetworkDnsZone.ts";
import {
  WorkloadNetworkPortMirroringProfile,
  WorkloadNetworkPortMirroringProfileProvider,
} from "./WorkloadNetworkPortMirroringProfile.ts";
import {
  WorkloadNetworkPublicIP,
  WorkloadNetworkPublicIPProvider,
} from "./WorkloadNetworkPublicIP.ts";
import {
  WorkloadNetworkSegment,
  WorkloadNetworkSegmentProvider,
} from "./WorkloadNetworkSegment.ts";
import {
  WorkloadNetworkVMGroup,
  WorkloadNetworkVMGroupProvider,
} from "./WorkloadNetworkVMGroup.ts";

export const resources = [
  Addon,
  CloudLink,
  Cluster,
  Datastore,
  ExpressRouteAuthorization,
  GlobalReachConnection,
  HcxEnterpriseSite,
  IscsiPath,
  License,
  PlacementPolicy,
  PrivateCloud,
  PureStoragePolicy,
  WorkloadNetworkDhcp,
  WorkloadNetworkDnsService,
  WorkloadNetworkDnsZone,
  WorkloadNetworkPortMirroringProfile,
  WorkloadNetworkPublicIP,
  WorkloadNetworkSegment,
  WorkloadNetworkVMGroup,
];
export const layers = () =>
  Layer.mergeAll(
    AddonProvider(),
    CloudLinkProvider(),
    ClusterProvider(),
    DatastoreProvider(),
    ExpressRouteAuthorizationProvider(),
    GlobalReachConnectionProvider(),
    HcxEnterpriseSiteProvider(),
    IscsiPathProvider(),
    LicenseProvider(),
    PlacementPolicyProvider(),
    PrivateCloudProvider(),
    PureStoragePolicyProvider(),
    WorkloadNetworkDhcpProvider(),
    WorkloadNetworkDnsServiceProvider(),
    WorkloadNetworkDnsZoneProvider(),
    WorkloadNetworkPortMirroringProfileProvider(),
    WorkloadNetworkPublicIPProvider(),
    WorkloadNetworkSegmentProvider(),
    WorkloadNetworkVMGroupProvider(),
  );
