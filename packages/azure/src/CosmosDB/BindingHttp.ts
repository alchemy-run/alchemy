import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import { Application } from "../Entra/Application.ts";
import { ServicePrincipal } from "../Entra/ServicePrincipal.ts";
import type { SqlContainer } from "./SqlContainer.ts";
import { SqlBuiltInRole, SqlRoleAssignment } from "./SqlRoleAssignment.ts";
import { SqlRoleDefinition } from "./SqlRoleDefinition.ts";

/**
 * Shared scaffolding for the Cosmos DB for NoSQL document bindings: the
 * data-plane role each binding assigns on its container, and the runtime
 * callables over the distilled `cosmos-nosql` operations.
 *
 * NOT exported from `index.ts`.
 */

const ACCOUNT = "Microsoft.DocumentDB/databaseAccounts";
const CONTAINERS = `${ACCOUNT}/sqlDatabases/containers`;

/** Cosmos DB for NoSQL data actions the bindings grant. */
export const CosmosDataAction = {
  readMetadata: `${ACCOUNT}/readMetadata`,
  read: `${CONTAINERS}/items/read`,
  create: `${CONTAINERS}/items/create`,
  replace: `${CONTAINERS}/items/replace`,
  upsert: `${CONTAINERS}/items/upsert`,
  delete: `${CONTAINERS}/items/delete`,
  executeQuery: `${CONTAINERS}/executeQuery`,
  readChangeFeed: `${CONTAINERS}/readChangeFeed`,
} as const;

/**
 * The Cosmos DB data role a binding assigns to its host on the container:
 * a built-in role, or a custom role with exactly `dataActions`. `kind`
 * names the role and the assignment.
 */
export type ContainerRole =
  | { readonly kind: string; readonly builtInRole: string }
  | { readonly kind: string; readonly dataActions: readonly string[] };

const A = CosmosDataAction;

/** One role per binding kind. Every custom role also reads account metadata. */
export const ContainerRoles = {
  CreateDocument: { kind: "CosmosCreateDocument", dataActions: [A.readMetadata, A.create] },
  DeleteDocument: { kind: "CosmosDeleteDocument", dataActions: [A.readMetadata, A.delete] },
  GetDocument: { kind: "CosmosGetDocument", dataActions: [A.readMetadata, A.read] },
  ListDocuments: {
    kind: "CosmosListDocuments",
    dataActions: [A.readMetadata, A.readChangeFeed],
  },
  // A patch changes an existing item: Cosmos DB checks `items/replace`, so
  // it shares the replace role (and a host binding both gets one assignment).
  PatchDocument: { kind: "CosmosReplaceDocument", dataActions: [A.readMetadata, A.replace] },
  QueryDocuments: {
    kind: "CosmosQueryDocuments",
    dataActions: [A.readMetadata, A.executeQuery, A.readChangeFeed],
  },
  ReplaceDocument: { kind: "CosmosReplaceDocument", dataActions: [A.readMetadata, A.replace] },
  UpsertDocument: { kind: "CosmosUpsertDocument", dataActions: [A.readMetadata, A.upsert] },
  // The built-in reader has exactly the read, list, and query actions.
  SqlContainerRead: { kind: "CosmosSqlContainerRead", builtInRole: SqlBuiltInRole.DataReader },
  SqlContainerWrite: {
    kind: "CosmosSqlContainerWrite",
    dataActions: [A.readMetadata, A.create, A.upsert, A.replace, A.delete],
  },
  // Narrower than the built-in contributor (no stored procedures, conflicts, or unmask).
  SqlContainerReadWrite: {
    kind: "CosmosSqlContainerReadWrite",
    dataActions: [
      A.readMetadata,
      A.read,
      A.create,
      A.upsert,
      A.replace,
      A.delete,
      A.executeQuery,
      A.readChangeFeed,
    ],
  },
} as const satisfies Record<string, ContainerRole>;

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

type GrantOnContainer = (
  tag: string,
  container: SqlContainer,
  role: ContainerRole,
) => Effect.Effect<void>;

/**
 * Attach the binding to its host and assign `role` to the host's principal
 * on the container only (`/dbs/{db}/colls/{container}`). A custom role is
 * one `SqlRoleDefinition` per container and binding kind, assignable only
 * on that container and shared by every host that binds it.
 */
const GrantOnContainer: Effect.Effect<GrantOnContainer> = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // The role resources exist only at deploy; a host bundle drops them.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const principalOf = yield* HostPrincipal;
  const RoleDefinition = yield* SqlRoleDefinition;
  const RoleAssignment = yield* SqlRoleAssignment;
  return Effect.fn(function* (tag: string, container: SqlContainer, role: ContainerRole) {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    // On a host without a managed identity this also creates its service
    // principal and binds the client secret into its env.
    yield* bind`${tag}(${container})`({});
    const host = yield* Binding.Host;
    if (host === undefined) return;
    const principalId = yield* principalOf(host);
    const scope = Output.interpolate`/dbs/${container.database}/colls/${container.containerName}`;
    let roleDefinitionId: Input<string>;
    if ("builtInRole" in role) {
      roleDefinitionId = role.builtInRole;
    } else {
      const definition = yield* RoleDefinition(`${container.LogicalId}${role.kind}Role`, {
        resourceGroup: container.resourceGroup,
        account: container.account,
        assignableScopes: [scope],
        permissions: [{ dataActions: [...role.dataActions] }],
      });
      roleDefinitionId = definition.roleDefinitionId;
    }
    yield* RoleAssignment(`${host.LogicalId}${container.LogicalId}${role.kind}`, {
      resourceGroup: container.resourceGroup,
      account: container.account,
      roleDefinitionId,
      principalId,
      scope,
    });
  });
});

/** The request members the bound container supplies. */
type ContainerIds = "accountName" | "databaseId" | "collectionId";

/** Where a container's documents live, resolved per call at runtime. */
interface ContainerAddress {
  readonly accountName: Effect.Effect<string>;
  readonly databaseId: Effect.Effect<string>;
  readonly collectionId: Effect.Effect<string>;
}

const addressOf = Effect.fn(function* (container: SqlContainer) {
  const accountName = yield* container.account;
  const databaseId = yield* container.database;
  const collectionId = yield* container.containerName;
  return { accountName, databaseId, collectionId } satisfies ContainerAddress;
});

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/** Call `op` on the container at `address`, adding its account, database, and container. */
const onContainer = <I, A, E>(name: string, op: Operation<I, A, E>, address: ContainerAddress) =>
  Effect.fn(name)(function* (request?: Omit<I, ContainerIds>) {
    const accountName = yield* address.accountName;
    const databaseId = yield* address.databaseId;
    const collectionId = yield* address.collectionId;
    // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
    return yield* op({ ...request, accountName, databaseId, collectionId } as I);
  });

/**
 * Build a per-operation binding: assigns `role` on the container at deploy
 * and returns `operation` with the container's identifiers filled in.
 */
export const makeDocumentBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CosmosDB.GetDocument`. */
  tag: string;
  role: ContainerRole;
  /** The distilled `cosmos-nosql` operation. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
}) =>
  Effect.gen(function* () {
    const grantOnContainer = yield* GrantOnContainer;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (container: SqlContainer) {
      yield* grantOnContainer(options.tag, container, options.role);
      const address = yield* addressOf(container);
      return onContainer(`${options.tag}(${container.LogicalId})`, op, address);
    });
  });

/** Every document operation, resolved once when the layer is built. */
const DocumentOperations = Effect.gen(function* () {
  // One at a time: `Effect.all` over distilled operations dies.
  const create = yield* AzureBindings.withCredentials(cosmos.CreateDocument);
  const remove = yield* AzureBindings.withCredentials(cosmos.DeleteDocument);
  const get = yield* AzureBindings.withCredentials(cosmos.GetDocument);
  const list = yield* AzureBindings.withCredentials(cosmos.ListDocuments);
  const patch = yield* AzureBindings.withCredentials(cosmos.PatchDocument);
  const query = yield* AzureBindings.withCredentials(cosmos.QueryDocuments);
  const replace = yield* AzureBindings.withCredentials(cosmos.ReplaceDocument);
  const upsert = yield* AzureBindings.withCredentials(cosmos.UpsertDocument);
  return (name: string, address: ContainerAddress) => ({
    create: onContainer(`${name}.create`, create, address),
    delete: onContainer(`${name}.delete`, remove, address),
    get: onContainer(`${name}.get`, get, address),
    list: onContainer(`${name}.list`, list, address),
    patch: onContainer(`${name}.patch`, patch, address),
    query: onContainer(`${name}.query`, query, address),
    replace: onContainer(`${name}.replace`, replace, address),
    upsert: onContainer(`${name}.upsert`, upsert, address),
  });
});

/** The document callables of one container, as {@link makeSqlContainerBinding} hands them to `makeClient`. */
export type DocumentCallables = ReturnType<Effect.Success<typeof DocumentOperations>>;

/**
 * Build a Read/Write/ReadWrite container binding: assigns `role` on the
 * container at deploy and returns `makeClient`'s client over the document
 * callables.
 */
export const makeSqlContainerBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CosmosDB.SqlContainerRead`. */
  tag: string;
  role: ContainerRole;
  makeClient: (documents: DocumentCallables) => Client;
}) =>
  Effect.gen(function* () {
    const grantOnContainer = yield* GrantOnContainer;
    const operations = yield* DocumentOperations;
    return Effect.fn(function* (container: SqlContainer) {
      yield* grantOnContainer(options.tag, container, options.role);
      const address = yield* addressOf(container);
      return options.makeClient(operations(`${options.tag}(${container.LogicalId})`, address));
    });
  });
