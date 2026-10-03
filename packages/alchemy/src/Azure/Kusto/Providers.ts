import * as Layer from "effect/Layer";
import {
  AttachedDatabaseConfiguration,
  AttachedDatabaseConfigurationProvider,
} from "./AttachedDatabaseConfiguration.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import {
  ClusterPrincipalAssignment,
  ClusterPrincipalAssignmentProvider,
} from "./ClusterPrincipalAssignment.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import {
  DatabasePrincipalAssignment,
  DatabasePrincipalAssignmentProvider,
} from "./DatabasePrincipalAssignment.ts";
import { DataConnection, DataConnectionProvider } from "./DataConnection.ts";
import {
  ManagedPrivateEndpoint,
  ManagedPrivateEndpointProvider,
} from "./ManagedPrivateEndpoint.ts";
import {
  SandboxCustomImage,
  SandboxCustomImageProvider,
} from "./SandboxCustomImage.ts";
import { Script, ScriptProvider } from "./Script.ts";

export const resources = [
  AttachedDatabaseConfiguration,
  Cluster,
  ClusterPrincipalAssignment,
  Database,
  DatabasePrincipalAssignment,
  DataConnection,
  ManagedPrivateEndpoint,
  SandboxCustomImage,
  Script,
];
export const layers = () =>
  Layer.mergeAll(
    AttachedDatabaseConfigurationProvider(),
    ClusterProvider(),
    ClusterPrincipalAssignmentProvider(),
    DatabaseProvider(),
    DatabasePrincipalAssignmentProvider(),
    DataConnectionProvider(),
    ManagedPrivateEndpointProvider(),
    SandboxCustomImageProvider(),
    ScriptProvider(),
  );
