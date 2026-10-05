import * as Layer from "effect/Layer";
import { Community, CommunityProvider } from "./Community.ts";
import {
  CommunityEndpoint,
  CommunityEndpointProvider,
} from "./CommunityEndpoint.ts";
import { DedicatedHub, DedicatedHubProvider } from "./DedicatedHub.ts";
import {
  EnclaveConnection,
  EnclaveConnectionProvider,
} from "./EnclaveConnection.ts";
import { EnclaveEndpoint, EnclaveEndpointProvider } from "./EnclaveEndpoint.ts";
import { TransitHub, TransitHubProvider } from "./TransitHub.ts";
import { VirtualEnclave, VirtualEnclaveProvider } from "./VirtualEnclave.ts";
import { Workload, WorkloadProvider } from "./Workload.ts";

export const resources = [
  Community,
  CommunityEndpoint,
  DedicatedHub,
  EnclaveConnection,
  EnclaveEndpoint,
  TransitHub,
  VirtualEnclave,
  Workload,
];
export const layers = () =>
  Layer.mergeAll(
    CommunityProvider(),
    CommunityEndpointProvider(),
    DedicatedHubProvider(),
    EnclaveConnectionProvider(),
    EnclaveEndpointProvider(),
    TransitHubProvider(),
    VirtualEnclaveProvider(),
    WorkloadProvider(),
  );
