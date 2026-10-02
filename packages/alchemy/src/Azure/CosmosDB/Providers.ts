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
import { DatabaseAccount, DatabaseAccountProvider } from "./DatabaseAccount.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";
import { Fleetspace, FleetspaceProvider } from "./Fleetspace.ts";
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
import { Table, TableProvider } from "./Table.ts";

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
  );
