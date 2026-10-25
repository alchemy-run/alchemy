import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Registry } from "./Registry.ts";

/**
 * Shared scaffolding for the Container Registry data-plane bindings:
 * resolves the distilled `containerregistry-data` operation once when the
 * layer is built, injects the bound registry's endpoint, and assigns the
 * binding's custom role on that registry at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * Registry permissions. A registry in the default
 * `LegacyRegistryPermissions` mode checks the `actions`; one in
 * `AbacRepositoryPermissions` mode checks the repository `dataActions`.
 */
export const RegistryAction = {
  pull: "Microsoft.ContainerRegistry/registries/pull/read",
  push: "Microsoft.ContainerRegistry/registries/push/write",
  delete: "Microsoft.ContainerRegistry/registries/artifacts/delete",
  metadataRead: "Microsoft.ContainerRegistry/registries/metadata/read",
  metadataWrite: "Microsoft.ContainerRegistry/registries/metadata/write",
} as const;

export const RegistryDataAction = {
  contentRead: "Microsoft.ContainerRegistry/registries/repositories/content/read",
  contentWrite: "Microsoft.ContainerRegistry/registries/repositories/content/write",
  contentDelete: "Microsoft.ContainerRegistry/registries/repositories/content/delete",
  metadataRead: "Microsoft.ContainerRegistry/registries/repositories/metadata/read",
  metadataWrite: "Microsoft.ContainerRegistry/registries/repositories/metadata/write",
  metadataDelete: "Microsoft.ContainerRegistry/registries/repositories/metadata/delete",
  catalogRead: "Microsoft.ContainerRegistry/registries/catalog/read",
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, one per binding kind
 * and stack, defined at the subscription and assigned only on the bound
 * registry) with exactly these permissions.
 */
export interface RegistryGrant {
  readonly role: string;
  readonly actions: readonly string[];
  readonly dataActions: readonly string[];
}

/** Custom role per binding kind; the logical ID is `AzureContainerRegistry<role>Role`. */
export const RegistryRole = {
  /** Read manifests and blobs. */
  Pull: {
    role: "Pull",
    actions: [RegistryAction.pull],
    dataActions: [RegistryDataAction.contentRead],
  },
  /** Push blobs and manifests. */
  Push: {
    role: "Push",
    actions: [RegistryAction.push],
    dataActions: [RegistryDataAction.contentWrite],
  },
  /** Read repository, tag, and manifest properties. */
  ReadMetadata: {
    role: "ReadMetadata",
    actions: [RegistryAction.metadataRead],
    dataActions: [RegistryDataAction.metadataRead],
  },
  /** Change repository, tag, and manifest attributes. */
  WriteMetadata: {
    role: "WriteMetadata",
    actions: [RegistryAction.metadataWrite],
    dataActions: [RegistryDataAction.metadataWrite],
  },
  /** List the registry's repositories. */
  ListCatalog: {
    role: "ListCatalog",
    actions: [RegistryAction.metadataRead],
    dataActions: [RegistryDataAction.catalogRead],
  },
  /** Delete repositories, tags, manifests, and blobs. */
  Delete: {
    role: "Delete",
    actions: [RegistryAction.delete],
    dataActions: [RegistryDataAction.contentDelete, RegistryDataAction.metadataDelete],
  },
} as const satisfies Record<string, RegistryGrant>;

/** Assign `grants` on the registry to the host, creating the custom roles they name. */
const GrantRegistryRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, registry: Registry, grants: readonly RegistryGrant[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const role = yield* AzureRoleDefinition(`AzureContainerRegistry${grant.role}Role`, {
          description: `Alchemy Container Registry binding: ${[...grant.actions, ...grant.dataActions].join(", ")}`,
          permissions: [{ actions: [...grant.actions], dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({
          roleDefinitionId: role.roleDefinitionId,
          scope: registry.registryId,
        });
      }
      yield* bind`${tag}(${registry})`({ roleAssignments });
    }
  });
});

/** `https://<login server>`, resolved per call at runtime. */
export const registryEndpointOf = (registry: Registry) =>
  Output.interpolate`https://${registry.loginServer}`;

/**
 * Build the impl Effect for a registry operation whose request carries the
 * registry `endpoint`: the runtime callable injects the bound
 * {@link Registry}'s endpoint, and the deploy-time half assigns `grants` on
 * the registry.
 */
export const makeRegistryHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ContainerRegistry.GetManifest`. */
  tag: string;
  /** The distilled operation; the registry endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the registry. */
  grants: readonly RegistryGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantRegistryRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (registry: Registry) {
      yield* grant(options.tag, registry, options.grants);
      const endpoint = yield* registryEndpointOf(registry);
      return Effect.fn(`${options.tag}(${registry.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const base = yield* endpoint;
        return yield* op({ ...request, endpoint: base } as I);
      });
    });
  });

/**
 * Build the impl Effect for a binding over several registry operations
 * (`UploadBlob`): `makeCall` receives the resolved operations and the
 * registry endpoint and returns the runtime callable.
 */
export const makeRegistryCompositeBinding = <Ops, Call>(options: {
  tag: string;
  operations: Effect.Effect<Ops, never, any>;
  grants: readonly RegistryGrant[];
  makeCall: (ops: Ops, endpoint: Effect.Effect<string>, label: string) => Call;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantRegistryRoles;
    const ops = yield* options.operations;
    return Effect.fn(function* (registry: Registry) {
      yield* grant(options.tag, registry, options.grants);
      const endpoint = yield* registryEndpointOf(registry);
      return options.makeCall(ops, endpoint, `${options.tag}(${registry.LogicalId})`);
    });
  });
