import * as Layer from "effect/Layer";
import { DatabaseAccount, DatabaseAccountProvider } from "./DatabaseAccount.ts";
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
  DatabaseAccount,
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
    DatabaseAccountProvider(),
    MongoCollectionProvider(),
    MongoDatabaseProvider(),
    SqlContainerProvider(),
    SqlDatabaseProvider(),
    SqlRoleAssignmentProvider(),
    SqlRoleDefinitionProvider(),
    TableProvider(),
  );
