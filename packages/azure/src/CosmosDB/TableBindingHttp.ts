import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import { Application } from "../Entra/Application.ts";
import { ServicePrincipal } from "../Entra/ServicePrincipal.ts";
import {
  makeTableClients,
  quotedEntityKeys,
  type TableAddress,
} from "../Storage/TableBindingHttp.ts";
import type { Table } from "./Table.ts";
import { TableRoleAssignment } from "./TableRoleAssignment.ts";
import { TableRoleDefinition } from "./TableRoleDefinition.ts";

/**
 * Shared scaffolding for the Cosmos DB for Table entity bindings. They call
 * the same distilled `cosmos-tables` data plane as the Azure Table storage
 * bindings, at `https://{account}.table.cosmos.azure.com`, and authorize
 * with Cosmos DB data-plane roles (not Azure RBAC).
 *
 * NOT exported from `index.ts`.
 */

const ACCOUNT = "Microsoft.DocumentDB/databaseAccounts";
const CONTAINERS = `${ACCOUNT}/tables/containers`;

/** Cosmos DB for Table data actions the bindings grant. */
export const CosmosTableDataAction = {
  readMetadata: `${ACCOUNT}/readMetadata`,
  read: `${CONTAINERS}/entities/read`,
  create: `${CONTAINERS}/entities/create`,
  replace: `${CONTAINERS}/entities/replace`,
  upsert: `${CONTAINERS}/entities/upsert`,
  delete: `${CONTAINERS}/entities/delete`,
  executeQuery: `${CONTAINERS}/executeQuery`,
  executeStoredProcedure: `${CONTAINERS}/executeStoredProcedure`,
} as const;

/**
 * The Cosmos DB data role a binding assigns to its host on the table: a
 * built-in role, or a custom role with exactly `dataActions`. `kind` names
 * the role and the assignment.
 */
export type CosmosTableRole =
  | { readonly kind: string; readonly builtInRole: string }
  | { readonly kind: string; readonly dataActions: readonly string[] };

const A = CosmosTableDataAction;

/** One role per binding kind. Every custom role also reads account metadata. */
export const CosmosTableRoles = {
  // The built-in Data Reader also queries and reads the change feed.
  GetTableEntity: { kind: "CosmosGetTableEntity", dataActions: [A.readMetadata, A.read] },
  QueryTableEntities: {
    kind: "CosmosQueryTableEntities",
    dataActions: [A.readMetadata, A.executeQuery],
  },
  InsertTableEntity: { kind: "CosmosInsertTableEntity", dataActions: [A.readMetadata, A.create] },
  // Without If-Match a PUT or PATCH inserts or replaces; with it, it replaces.
  UpdateTableEntity: {
    kind: "CosmosUpsertTableEntity",
    dataActions: [A.readMetadata, A.upsert, A.replace],
  },
  // Cosmos DB runs a MERGE as the system stored procedure
  // `__.sys.tablesBatchOperation`.
  MergeTableEntity: {
    kind: "CosmosMergeTableEntity",
    dataActions: [A.readMetadata, A.executeStoredProcedure],
  },
  DeleteTableEntity: { kind: "CosmosDeleteTableEntity", dataActions: [A.readMetadata, A.delete] },
  TableRead: {
    kind: "CosmosTableRead",
    dataActions: [A.readMetadata, A.read, A.executeQuery],
  },
  // A `mode: "merge"` write is a MERGE (a system stored procedure).
  TableWrite: {
    kind: "CosmosTableWrite",
    dataActions: [
      A.readMetadata,
      A.create,
      A.upsert,
      A.replace,
      A.delete,
      A.executeStoredProcedure,
    ],
  },
  // Narrower than the built-in contributor (no table management or change feed).
  TableReadWrite: {
    kind: "CosmosTableReadWrite",
    dataActions: [
      A.readMetadata,
      A.read,
      A.executeQuery,
      A.create,
      A.upsert,
      A.replace,
      A.delete,
      A.executeStoredProcedure,
    ],
  },
} as const satisfies Record<string, CosmosTableRole>;

/**
 * The Entra principal a host's Azure calls run as: its managed identity
 * (`principalId`), or the service principal `AzureBindings.Bind` created for
 * a host without one. Cosmos DB data roles are not Azure RBAC roles, so they
 * cannot travel in `HostBinding.roleAssignments`.
 */
const HostPrincipal = Effect.gen(function* () {
  const EntraApplication = yield* Application;
  const EntraServicePrincipal = yield* ServicePrincipal;
  return Effect.fn(function* (host: ResourceLike) {
    if (AzureBindings.runsAsManagedIdentity(host)) {
      // Every managed-identity host has a `principalId` attribute;
      // `ResourceLike` does not carry attribute types.
      const { principalId } = host as unknown as {
        principalId: Output.Output<string | undefined>;
      };
      return principalId.pipe(Output.map((id) => id ?? ""));
    }
    // `AzureBindings.Bind` registered these under the same IDs and props;
    // declaring them again returns the registered resources.
    const id = `${host.LogicalId}AzureIdentity`;
    const app = yield* EntraApplication(id, {
      displayName: `Alchemy: Azure access for ${host.LogicalId}`.slice(0, 120),
      notes: `Created by Alchemy for ${host.Type} ${host.LogicalId} to call Azure.`,
    });
    const principal = yield* EntraServicePrincipal(`${id}Principal`, { appId: app.appId });
    return principal.objectId;
  });
});

type GrantOnTable = (tag: string, table: Table, role: CosmosTableRole) => Effect.Effect<void>;

/**
 * Attach the binding to its host and assign `role` to the host's principal
 * on the table only (`/dbs/TablesDB/colls/{table}`). A custom role is one
 * `TableRoleDefinition` per table and binding kind, assignable only on that
 * table and shared by every host that binds it.
 */
const GrantOnTable: Effect.Effect<GrantOnTable> = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // The role resources exist only at deploy; a host bundle drops them.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const principalOf = yield* HostPrincipal;
  const RoleDefinition = yield* TableRoleDefinition;
  const RoleAssignment = yield* TableRoleAssignment;
  return Effect.fn(function* (tag: string, table: Table, role: CosmosTableRole) {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    // On a host without a managed identity this also creates its service
    // principal and binds the client secret into its env.
    yield* bind`${tag}(${table})`({});
    const host = yield* Binding.Host;
    if (host === undefined) return;
    const principalId = yield* principalOf(host);
    const scope = Output.interpolate`/dbs/TablesDB/colls/${table.tableName}`;
    let roleDefinitionId: Input<string>;
    if ("builtInRole" in role) {
      roleDefinitionId = role.builtInRole;
    } else {
      const definition = yield* RoleDefinition(`${table.LogicalId}${role.kind}Role`, {
        resourceGroup: table.resourceGroup,
        account: table.account,
        assignableScopes: [scope],
        permissions: [{ dataActions: [...role.dataActions] }],
      });
      roleDefinitionId = definition.roleDefinitionId;
    }
    yield* RoleAssignment(`${host.LogicalId}${table.LogicalId}${role.kind}`, {
      resourceGroup: table.resourceGroup,
      account: table.account,
      roleDefinitionId,
      principalId,
      scope,
    });
  });
});

const tableAddress = Effect.fn(function* (tag: string, table: Table) {
  const url = yield* Output.interpolate`https://${table.account}.table.cosmos.azure.com`;
  const name = yield* table.tableName;
  return { tag: `${tag}(${table.LogicalId})`, url, table: name } satisfies TableAddress;
});

/**
 * Bind one entity operation of the distilled `cosmos-tables` data plane:
 * the runtime callable fills in the table's endpoint and name; the
 * deploy-time half assigns `role` on the table.
 */
export const makeCosmosTableOperationBinding = <
  I extends { url: string; table: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CosmosDB.GetTableEntity`. */
  tag: string;
  /** The distilled operation; `url` and `table` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  role: CosmosTableRole;
}) =>
  Effect.gen(function* () {
    const grantOnTable = yield* GrantOnTable;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (table: Table) {
      yield* grantOnTable(options.tag, table, options.role);
      const address = yield* tableAddress(options.tag, table);
      return Effect.fn(address.tag)(function* (request: Omit<I, "url" | "table">) {
        const url = yield* address.url;
        const name = yield* address.table;
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, url, table: name, ...quotedEntityKeys(request) } as I);
      });
    });
  });

/**
 * Build a Read/Write/ReadWrite Cosmos table binding: assigns `role` on the
 * table and returns the client `makeClient` builds.
 */
export const makeCosmosTableBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CosmosDB.TableRead`. */
  tag: string;
  role: CosmosTableRole;
  makeClient: (helpers: Effect.Success<typeof makeTableClients>, address: TableAddress) => Client;
}) =>
  Effect.gen(function* () {
    const grantOnTable = yield* GrantOnTable;
    const helpers = yield* makeTableClients;
    return Effect.fn(function* (table: Table) {
      yield* grantOnTable(options.tag, table, options.role);
      const address = yield* tableAddress(options.tag, table);
      return options.makeClient(helpers, address);
    });
  });
