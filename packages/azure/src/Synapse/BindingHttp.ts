import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import { Application } from "../Entra/Application.ts";
import { ServicePrincipal } from "../Entra/ServicePrincipal.ts";
import type { Workspace } from "./Workspace.ts";
import {
  SynapseRole,
  synapseDevEndpoint,
  WorkspaceRoleAssignment,
} from "./WorkspaceRoleAssignment.ts";

/**
 * Shared scaffolding for the Synapse lake database (SyMS) data-plane
 * bindings: resolves the distilled `synapse-data` operation once when the
 * layer is built, injects the bound workspace's development endpoint, and
 * assigns the binding's Synapse RBAC role on that workspace at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * The Synapse RBAC role a lake database binding assigns on the bound
 * workspace. Synapse has no custom roles; these are the smallest built-in
 * roles that answer each operation (live, 2026-10-25: **Synapse User** gets
 * 403 on every SyMS call, **Synapse SQL Administrator** gets 403 on writes).
 */
export type LakeDatabaseGrant = { readonly label: string; readonly roleId: string };

/** The roles the lake database bindings assign. */
export const LakeDatabaseRole = {
  /** **Synapse Artifact User**: reads published artifacts, lake databases included. */
  Read: { label: "ArtifactUser", roleId: SynapseRole.ArtifactUser },
  /** **Synapse Artifact Publisher**: creates, updates and deletes published artifacts. */
  Write: { label: "ArtifactPublisher", roleId: SynapseRole.ArtifactPublisher },
} as const satisfies Record<string, LakeDatabaseGrant>;

/**
 * The Entra principal a host's Azure calls run as: its managed identity
 * (`principalId`), or the service principal `AzureBindings.Bind` created for
 * a host without one. Synapse roles are not Azure RBAC roles, so they
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

type GrantOnWorkspace = (
  tag: string,
  workspace: Workspace,
  grant: LakeDatabaseGrant,
) => Effect.Effect<void>;

/**
 * Attach the binding to its host and assign `grant` to the host's
 * principal on the workspace (`workspaces/{name}`), one
 * `Azure.Synapse.WorkspaceRoleAssignment` per host, workspace and role.
 */
const GrantOnWorkspace: Effect.Effect<GrantOnWorkspace> = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // The role resources exist only at deploy; a host bundle drops them.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const principalOf = yield* HostPrincipal;
  const RoleAssignment = yield* WorkspaceRoleAssignment;
  return Effect.fn(function* (tag: string, workspace: Workspace, grant: LakeDatabaseGrant) {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    // On a host without a managed identity this also creates its service
    // principal and binds the client secret into its env.
    yield* bind`${tag}(${workspace})`({});
    const host = yield* Binding.Host;
    if (host === undefined) return;
    const principalId = yield* principalOf(host);
    yield* RoleAssignment(`${host.LogicalId}${workspace.LogicalId}Synapse${grant.label}`, {
      workspace: workspace.workspaceName,
      roleId: grant.roleId,
      principalId,
      principalType: "ServicePrincipal",
    });
  });
});

/**
 * Build the impl Effect for a lake database (SyMS) operation: the runtime
 * callable injects the bound {@link Workspace}'s development endpoint
 * (`https://{workspace}.dev.azuresynapse.net`), and the deploy-time half
 * assigns `grant` on the workspace.
 */
export const makeLakeDatabaseHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Synapse.GetDatabase`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Synapse role assigned on the workspace. */
  grant: LakeDatabaseGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnWorkspace;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (workspace: Workspace) {
      yield* grant(options.tag, workspace, options.grant);
      const workspaceName = yield* workspace.workspaceName;
      return Effect.fn(`${options.tag}(${workspace.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const name = yield* workspaceName;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: synapseDevEndpoint(name) } as I);
      });
    });
  });
