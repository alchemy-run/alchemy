import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Namespace } from "./Namespace.ts";
import type { SchemaGroup } from "./SchemaGroup.ts";
import {
  SchemaContentType,
  type Schema,
  type SchemaFormat,
  type SchemaProperties,
} from "./SchemaRegistryTypes.ts";

/**
 * Shared scaffolding for the Schema Registry bindings: the role each binding
 * assigns on its schema group (or namespace), and the runtime callables over
 * the distilled `schemaregistry-data` operations.
 *
 * NOT exported from `index.ts`.
 */

/**
 * What a binding does in the registry. Each level maps to one role, the
 * smallest that allows it:
 *
 * - `read`: built-in Schema Registry Reader (data action `schemas/read`,
 *   action `schemagroups/read`) on the schema group;
 * - `write`: a custom role per stack with only the data action
 *   `schemas/write`, on the group's namespace. Registration is refused
 *   with HTTP 401 `Authorization failed for specified action:
 *   SchemaGroupWrite,SchemaWrite` when the role (even the built-in Schema
 *   Registry Contributor) is assigned on the schema group. The built-in
 *   Contributor also grants `schemas/delete` and every schema-group action.
 */
export type SchemaRegistryAccess = "read" | "write";

/** The custom role of `write`, one per stack, shared by every host and namespace. */
const WRITER = {
  id: "AzureSchemaRegistryWriter",
  description:
    "Register schemas in Azure Schema Registry schema groups (Alchemy Schema Registry bindings).",
  dataActions: ["Microsoft.EventHub/namespaces/schemas/write"],
} as const;

/** One access level on one scope. */
interface Grant {
  readonly access: SchemaRegistryAccess;
  readonly scope: Input<string>;
}

/** Attach the binding to its host, assigning one role per grant. */
const GrantOn = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Deploy only: a host bundle never declares role definitions.
  const defineRole = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: SchemaGroup | Namespace,
    grants: readonly Grant[],
  ) {
    if (globalThis.__ALCHEMY_RUNTIME__ || defineRole === undefined) return;
    const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
    for (const { access, scope } of grants) {
      if (access === "read") {
        roleAssignments.push({ roleDefinitionId: BuiltInRole.SchemaRegistryReader, scope });
        continue;
      }
      const role = yield* defineRole(WRITER.id, {
        description: WRITER.description,
        permissions: [{ dataActions: [...WRITER.dataActions] }],
      });
      roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope });
    }
    yield* bind`${tag}(${resource})`({ roleAssignments });
  });
});

/** ARM ID of the namespace that holds a schema group. */
const namespaceIdOf = (group: SchemaGroup) =>
  group.schemaGroupId.pipe(Output.map((id) => id.replace(/\/schemagroups\/[^/]+$/i, "")));

/** Grant `access` for a schema group: reads on the group, writes on its namespace. */
const GrantOnSchemaGroup = Effect.map(
  GrantOn,
  (grantOn) => (tag: string, group: SchemaGroup, access: readonly SchemaRegistryAccess[]) =>
    grantOn(
      tag,
      group,
      access.map((level) => ({
        access: level,
        scope: level === "write" ? namespaceIdOf(group) : group.schemaGroupId,
      })),
    ),
);

/** Grant reads on the whole namespace (listing its schema groups). */
const GrantOnNamespace = Effect.map(
  GrantOn,
  (grantOn) => (tag: string, namespace: Namespace) =>
    grantOn(tag, namespace, [{ access: "read", scope: namespace.namespaceId }]),
);

/** The registry endpoint of a namespace: `<namespace>.servicebus.windows.net`. */
const endpointOf = (namespace: Input<string>) =>
  Output.interpolate`${namespace}.servicebus.windows.net`;

/** Where a schema group's schemas live, resolved per call at runtime. */
export interface SchemaGroupAddress {
  readonly tag: string;
  readonly fullyQualifiedNamespace: Effect.Effect<string>;
  readonly groupName: Effect.Effect<string>;
  /** The group's `schemaType`, the default {@link SchemaFormat}. */
  readonly schemaType: Effect.Effect<string | undefined>;
}

const addressOf = Effect.fn(function* (tag: string, group: SchemaGroup) {
  const fullyQualifiedNamespace = yield* endpointOf(group.namespace);
  const groupName = yield* group.schemaGroupName;
  const schemaType = yield* group.schemaType;
  return {
    tag: `${tag}(${group.LogicalId})`,
    fullyQualifiedNamespace,
    groupName,
    schemaType,
  } satisfies SchemaGroupAddress;
});

/** The request members a bound schema group supplies. */
export type SchemaGroupIds = "fullyQualifiedNamespace" | "groupName";

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build a per-operation schema group binding: the runtime callable takes the
 * distilled request without the members the group supplies (`supplies`), and
 * the deploy-time half grants `access` (reads on the group, writes on its
 * namespace).
 */
export const makeSchemaGroupOperationBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.EventHub.RegisterSchema`. */
  tag: string;
  /** The distilled `schemaregistry-data` operation. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** What the operation does in the group. */
  access: SchemaRegistryAccess;
  /** The members the group fills in; `GetSchemaById` takes no group name. */
  supplies: readonly SchemaGroupIds[];
}) =>
  Effect.gen(function* () {
    const grantOnSchemaGroup = yield* GrantOnSchemaGroup;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (group: SchemaGroup) {
      yield* grantOnSchemaGroup(options.tag, group, [options.access]);
      const address = yield* addressOf(options.tag, group);
      return Effect.fn(address.tag)(function* (request: Omit<I, SchemaGroupIds>) {
        const fullyQualifiedNamespace = yield* address.fullyQualifiedNamespace;
        const groupName = yield* address.groupName;
        const ids = options.supplies.includes("groupName")
          ? { fullyQualifiedNamespace, groupName }
          : { fullyQualifiedNamespace };
        // `Omit<I, K>` plus the supplied members is `I`; TypeScript cannot
        // prove an `Omit` round-trip over a generic `I`.
        return yield* op({ ...request, ...ids } as unknown as I);
      });
    });
  });

/** {@link ListSchemaGroups}: grants Schema Registry Reader on the namespace. */
export const makeListSchemaGroupsBinding = (tag: string) =>
  Effect.gen(function* () {
    const grantOnNamespace = yield* GrantOnNamespace;
    const list = yield* AzureBindings.withCredentials(registry.ListSchemaGroups);
    return Effect.fn(function* (namespace: Namespace) {
      yield* grantOnNamespace(tag, namespace);
      const endpoint = yield* endpointOf(namespace.namespaceName);
      return Effect.fn(`${tag}(${namespace.LogicalId})`)(function* (
        request?: Omit<registry.ListSchemaGroupsRequest, "fullyQualifiedNamespace">,
      ) {
        const fullyQualifiedNamespace = yield* endpoint;
        return yield* list({ ...request, fullyQualifiedNamespace });
      });
    });
  });

/** The default format of a group: its `schemaType`. */
const formatOf = (schemaType: string | undefined): SchemaFormat => {
  switch (schemaType?.toLowerCase()) {
    case "avro":
      return "Avro";
    case "json":
      return "Json";
    case "protobuf":
      return "Protobuf";
    default:
      return "Custom";
  }
};

/** Read the schema identity from the `Schema-*` response headers. */
const propertiesOf = (
  res: registry.RegisterSchemaResponse,
  fallback: { groupName: string; schemaName: string },
): SchemaProperties => ({
  id: res.schemaId ?? "",
  groupName: res.schemaGroupName ?? fallback.groupName,
  schemaName: res.schemaName ?? fallback.schemaName,
  version: res.schemaVersion ?? 0,
});

const schemaOf = (res: registry.GetSchemaByIdResponse): Schema => ({
  id: res.schemaId ?? "",
  groupName: res.schemaGroupName ?? "",
  schemaName: res.schemaName ?? "",
  version: res.schemaVersion ?? 0,
  contentType: res.contentType,
  content: new TextDecoder().decode(res.body),
});

/** Every schema operation, resolved once when the layer is built. */
const makeSchemaGroupHelpers = Effect.gen(function* () {
  // One at a time: `Effect.all` over distilled operations dies.
  const getById = yield* AzureBindings.withCredentials(registry.GetSchemaById);
  const getByVersion = yield* AzureBindings.withCredentials(registry.GetSchemaByVersion);
  const getProperties = yield* AzureBindings.withCredentials(registry.GetSchemaPropertiesByContent);
  const listVersions = yield* AzureBindings.withCredentials(registry.ListSchemaVersions);
  const register = yield* AzureBindings.withCredentials(registry.RegisterSchema);

  const at = (address: SchemaGroupAddress) =>
    Effect.gen(function* () {
      const fullyQualifiedNamespace = yield* address.fullyQualifiedNamespace;
      const groupName = yield* address.groupName;
      return { fullyQualifiedNamespace, groupName };
    });

  const contentTypeOf = (address: SchemaGroupAddress, format: SchemaFormat | undefined) =>
    Effect.gen(function* () {
      if (format !== undefined) return SchemaContentType[format];
      const schemaType = yield* address.schemaType;
      return SchemaContentType[formatOf(schemaType)];
    });

  const makeRead = (address: SchemaGroupAddress) => ({
    getSchema: Effect.fn(`${address.tag}.getSchema`)(function* (id: string) {
      const { fullyQualifiedNamespace } = yield* at(address);
      const res = yield* getById({ fullyQualifiedNamespace, id });
      return schemaOf(res);
    }),
    getSchemaVersion: Effect.fn(`${address.tag}.getSchemaVersion`)(function* (
      schemaName: string,
      version: number,
    ) {
      const where = yield* at(address);
      const res = yield* getByVersion({ ...where, schemaName, schemaVersion: version });
      return schemaOf(res);
    }),
    getSchemaProperties: Effect.fn(`${address.tag}.getSchemaProperties`)(function* (
      schemaName: string,
      content: string,
      format?: SchemaFormat,
    ) {
      const where = yield* at(address);
      const contentType = yield* contentTypeOf(address, format);
      const res = yield* getProperties({ ...where, schemaName, body: content, contentType });
      return propertiesOf(res, { groupName: where.groupName, schemaName });
    }),
    listSchemaVersions: Effect.fn(`${address.tag}.listSchemaVersions`)(function* (
      schemaName: string,
    ) {
      const where = yield* at(address);
      const versions = yield* Stream.runCollect(listVersions.items({ ...where, schemaName }));
      // The service answers a `NextLink` on a complete first page, and that
      // page repeats its trailing versions (`[1, 2]`, then `[2]`).
      return [...new Set(versions)].sort((a, b) => a - b);
    }),
  });

  const makeWrite = (address: SchemaGroupAddress) => ({
    registerSchema: Effect.fn(`${address.tag}.registerSchema`)(function* (
      schemaName: string,
      content: string,
      format?: SchemaFormat,
    ) {
      const where = yield* at(address);
      const contentType = yield* contentTypeOf(address, format);
      const res = yield* register({ ...where, schemaName, body: content, contentType });
      return propertiesOf(res, { groupName: where.groupName, schemaName });
    }),
  });

  return { makeRead, makeWrite };
});

/** The read and write clients of one schema group, as {@link makeSchemaGroupBinding} builds them. */
export type SchemaGroupHelpers = Effect.Success<typeof makeSchemaGroupHelpers>;

/**
 * Build a Read/Write/ReadWrite schema group binding: grants `access` on the
 * group at deploy and returns `makeClient`'s client.
 */
export const makeSchemaGroupBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.EventHub.SchemaGroupRead`. */
  tag: string;
  /** What the client does in the group; one role per level. */
  access: readonly SchemaRegistryAccess[];
  makeClient: (helpers: SchemaGroupHelpers, address: SchemaGroupAddress) => Client;
}) =>
  Effect.gen(function* () {
    const grantOnSchemaGroup = yield* GrantOnSchemaGroup;
    const helpers = yield* makeSchemaGroupHelpers;
    return Effect.fn(function* (group: SchemaGroup) {
      yield* grantOnSchemaGroup(options.tag, group, options.access);
      const address = yield* addressOf(options.tag, group);
      return options.makeClient(helpers, address);
    });
  });
