import * as Layer from "effect/Layer";
import { BatchDeployment, BatchDeploymentProvider } from "./BatchDeployment.ts";
import { BatchEndpoint, BatchEndpointProvider } from "./BatchEndpoint.ts";
import { CapabilityHost, CapabilityHostProvider } from "./CapabilityHost.ts";
import { Compute, ComputeProvider } from "./Compute.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { Datastore, DatastoreProvider } from "./Datastore.ts";
import {
  OnlineDeployment,
  OnlineDeploymentProvider,
} from "./OnlineDeployment.ts";
import { OnlineEndpoint, OnlineEndpointProvider } from "./OnlineEndpoint.ts";
import { OutboundRule, OutboundRuleProvider } from "./OutboundRule.ts";
import { Registry, RegistryProvider } from "./Registry.ts";
import { Schedule, ScheduleProvider } from "./Schedule.ts";
import {
  ServerlessEndpoint,
  ServerlessEndpointProvider,
} from "./ServerlessEndpoint.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  BatchDeployment,
  BatchEndpoint,
  CapabilityHost,
  Compute,
  Connection,
  Datastore,
  OnlineDeployment,
  OnlineEndpoint,
  OutboundRule,
  Registry,
  Schedule,
  ServerlessEndpoint,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    BatchDeploymentProvider(),
    BatchEndpointProvider(),
    CapabilityHostProvider(),
    ComputeProvider(),
    ConnectionProvider(),
    DatastoreProvider(),
    OnlineDeploymentProvider(),
    OnlineEndpointProvider(),
    OutboundRuleProvider(),
    RegistryProvider(),
    ScheduleProvider(),
    ServerlessEndpointProvider(),
    WorkspaceProvider(),
  );
