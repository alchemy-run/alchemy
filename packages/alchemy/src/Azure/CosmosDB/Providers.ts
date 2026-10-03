import * as Layer from "effect/Layer";
import {
  CassandraCluster,
  CassandraClusterProvider,
} from "./CassandraCluster.ts";
import {
  CassandraDataCenter,
  CassandraDataCenterProvider,
} from "./CassandraDataCenter.ts";
import {
  CassandraKeyspace,
  CassandraKeyspaceProvider,
} from "./CassandraKeyspace.ts";
import {
  CassandraRoleAssignment,
  CassandraRoleAssignmentProvider,
} from "./CassandraRoleAssignment.ts";
import {
  CassandraRoleDefinition,
  CassandraRoleDefinitionProvider,
} from "./CassandraRoleDefinition.ts";
import {
  ClientEncryptionKey,
  ClientEncryptionKeyProvider,
} from "./ClientEncryptionKey.ts";
import { DatabaseAccount, DatabaseAccountProvider } from "./DatabaseAccount.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";
import { Fleetspace, FleetspaceProvider } from "./Fleetspace.ts";
import {
  FleetspaceAccount,
  FleetspaceAccountProvider,
} from "./FleetspaceAccount.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { GremlinDatabase, GremlinDatabaseProvider } from "./GremlinDatabase.ts";
import { MongoCluster, MongoClusterProvider } from "./MongoCluster.ts";
import {
  MongoClusterFirewallRule,
  MongoClusterFirewallRuleProvider,
} from "./MongoClusterFirewallRule.ts";
import {
  MongoClusterUser,
  MongoClusterUserProvider,
} from "./MongoClusterUser.ts";
import { MongoCollection, MongoCollectionProvider } from "./MongoCollection.ts";
import { MongoDatabase, MongoDatabaseProvider } from "./MongoDatabase.ts";
import { SqlContainer, SqlContainerProvider } from "./SqlContainer.ts";
import { SqlDatabase, SqlDatabaseProvider } from "./SqlDatabase.ts";
import {
  SqlRoleAssignment,
  SqlRoleAssignmentProvider,
} from "./SqlRoleAssignment.ts";
import {
  SqlRoleDefinition,
  SqlRoleDefinitionProvider,
} from "./SqlRoleDefinition.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { Table, TableProvider } from "./Table.ts";
import {
  GremlinRoleDefinition,
  GremlinRoleDefinitionProvider,
} from "./GremlinRoleDefinition.ts";
import {
  GremlinRoleAssignment,
  GremlinRoleAssignmentProvider,
} from "./GremlinRoleAssignment.ts";
import {
  TableRoleDefinition,
  TableRoleDefinitionProvider,
} from "./TableRoleDefinition.ts";
import {
  TableRoleAssignment,
  TableRoleAssignmentProvider,
} from "./TableRoleAssignment.ts";
import {
  MongoMIRoleDefinition,
  MongoMIRoleDefinitionProvider,
} from "./MongoMIRoleDefinition.ts";
import {
  MongoMIRoleAssignment,
  MongoMIRoleAssignmentProvider,
} from "./MongoMIRoleAssignment.ts";
import {
  SqlStoredProcedure,
  SqlStoredProcedureProvider,
} from "./SqlStoredProcedure.ts";
import { SqlTrigger, SqlTriggerProvider } from "./SqlTrigger.ts";
import {
  SqlUserDefinedFunction,
  SqlUserDefinedFunctionProvider,
} from "./SqlUserDefinedFunction.ts";
import { CassandraTable, CassandraTableProvider } from "./CassandraTable.ts";
import { GremlinGraph, GremlinGraphProvider } from "./GremlinGraph.ts";
import {
  MongoRoleDefinition,
  MongoRoleDefinitionProvider,
} from "./MongoRoleDefinition.ts";
import {
  MongoUserDefinition,
  MongoUserDefinitionProvider,
} from "./MongoUserDefinition.ts";

export const resources = [
  CassandraCluster,
  CassandraDataCenter,
  CassandraKeyspace,
  CassandraRoleAssignment,
  CassandraRoleDefinition,
  DatabaseAccount,
  Fleet,
  Fleetspace,
  GremlinDatabase,
  MongoCluster,
  MongoClusterFirewallRule,
  MongoClusterUser,
  MongoCollection,
  MongoDatabase,
  SqlContainer,
  SqlDatabase,
  SqlRoleAssignment,
  SqlRoleDefinition,
  Table,
  GremlinRoleDefinition,
  GremlinRoleAssignment,
  TableRoleDefinition,
  TableRoleAssignment,
  MongoMIRoleDefinition,
  MongoMIRoleAssignment,
  SqlStoredProcedure,
  SqlTrigger,
  SqlUserDefinedFunction,
  CassandraTable,
  GremlinGraph,
  MongoRoleDefinition,
  MongoUserDefinition,
  FleetspaceAccount,
  PrivateEndpointConnection,
  ClientEncryptionKey,
  Service,
];
export const layers = () =>
  Layer.mergeAll(
    CassandraClusterProvider(),
    CassandraDataCenterProvider(),
    CassandraKeyspaceProvider(),
    CassandraRoleAssignmentProvider(),
    CassandraRoleDefinitionProvider(),
    DatabaseAccountProvider(),
    FleetProvider(),
    FleetspaceProvider(),
    GremlinDatabaseProvider(),
    MongoClusterProvider(),
    MongoClusterFirewallRuleProvider(),
    MongoClusterUserProvider(),
    MongoCollectionProvider(),
    MongoDatabaseProvider(),
    SqlContainerProvider(),
    SqlDatabaseProvider(),
    SqlRoleAssignmentProvider(),
    SqlRoleDefinitionProvider(),
    TableProvider(),
    GremlinRoleDefinitionProvider(),
    GremlinRoleAssignmentProvider(),
    TableRoleDefinitionProvider(),
    TableRoleAssignmentProvider(),
    MongoMIRoleDefinitionProvider(),
    MongoMIRoleAssignmentProvider(),
    SqlStoredProcedureProvider(),
    SqlTriggerProvider(),
    SqlUserDefinedFunctionProvider(),
    CassandraTableProvider(),
    GremlinGraphProvider(),
    MongoRoleDefinitionProvider(),
    MongoUserDefinitionProvider(),
    FleetspaceAccountProvider(),
    PrivateEndpointConnectionProvider(),
    ClientEncryptionKeyProvider(),
    ServiceProvider(),
  );
