import * as syms from "@distilled.cloud/azure/synapse-data";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { deterministicGuid } from "../Authorization/Ownership.ts";
import type { Providers } from "../Providers.ts";

/**
 * Built-in Synapse RBAC role IDs (the same in every workspace). Synapse
 * RBAC is the workspace's own access control for its development endpoint
 * (`https://{workspace}.dev.azuresynapse.net`), separate from Azure RBAC.
 */
export const SynapseRole = {
  /** Full access, including assigning Synapse roles. */
  Administrator: "6e4bf58a-b8e1-4cc3-bbf9-d73143322b78",
  /** Full access to Apache Spark pools and their artifacts. */
  ApacheSparkAdministrator: "c3a6d2f1-a26f-4810-9b0f-591308d5cbf1",
  /** Full access to serverless SQL pools, SQL scripts, credentials and linked services. */
  SqlAdministrator: "7af0c69a-a548-47d6-aea3-d00e69bd83aa",
  /** Full access to Spark pools, integration runtimes and all published artifacts. */
  Contributor: "7572bffe-f453-4b66-912a-46cc5ef38fda",
  /** Create, read, update and delete published artifacts (incl. lake databases). */
  ArtifactPublisher: "05930f57-09a3-4c0d-9fa9-6d1eb91c178b",
  /** Read published artifacts (incl. lake databases). */
  ArtifactUser: "53faaa0e-40b6-40c8-a2ff-e38f2d388875",
  /** Submit and cancel Spark jobs and notebooks; view logs. */
  ComputeOperator: "e3844cc7-4670-42cb-9349-9bdac1ee7881",
  /** Use the secrets of credentials and linked services. */
  CredentialUser: "5eb298b4-692c-4241-9cf0-f58a3b42bb25",
  /** Manage managed private endpoints, linked services and credentials. */
  LinkedDataManager: "dd665582-e433-40ca-b183-1b1b33e73375",
  /** Read published artifacts and run outputs; view pool and runtime logs. */
  MonitoringOperator: "8f9b2195-5b12-4a7c-af30-8f1f46197650",
  /** List and read pools, integration runtimes, linked services and credentials. */
  User: "2a385764-43e8-416c-9825-7b18d05a2c4b",
} as const;

export interface WorkspaceRoleAssignmentProps {
  /** Name of the Synapse workspace. Changing it replaces the assignment. */
  workspace: string;
  /**
   * Synapse role definition ID, e.g. {@link SynapseRole}`.User`. Changing
   * it replaces the assignment.
   */
  roleId: string;
  /**
   * Microsoft Entra object ID of the user, group, service principal or
   * managed identity that gets the role. Changing it replaces the
   * assignment.
   */
  principalId: string;
  /**
   * Type of the principal. Set it for a service principal created in the
   * same deploy: Synapse skips the directory lookup that fails while it
   * replicates.
   */
  principalType?: "User" | "Group" | "ServicePrincipal";
  /**
   * Scope inside the workspace, e.g. `workspaces/{workspace}/bigDataPools/{pool}`.
   * Changing it replaces the assignment.
   * @default `workspaces/{workspace}`
   */
  scope?: string;
}

export interface WorkspaceRoleAssignment extends Resource<
  "Azure.Synapse.WorkspaceRoleAssignment",
  WorkspaceRoleAssignmentProps,
  {
    /** Synapse role assignment ID (a GUID). */
    roleAssignmentId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Synapse role definition ID. */
    roleId: string;
    /** Object ID of the principal that has the role. */
    principalId: string;
    /** Scope of the assignment. */
    scope: string;
  },
  never,
  Providers
> {}

/**
 * A Synapse RBAC role held by a Microsoft Entra principal in a Synapse
 * workspace, managed through the workspace's access-control data plane
 * (`/roleAssignments`).
 *
 * Synapse RBAC authorizes the workspace's development endpoint (Synapse
 * Studio, lake databases, artifacts, Spark jobs); Azure RBAC on the
 * workspace resource does not. The deploying identity must be a **Synapse
 * Administrator** of the workspace (its creator is), and the workspace
 * firewall must admit the deployer.
 *
 * ### Granting Synapse Roles
 * **Example:** Let a managed identity publish lake databases
 * ```typescript
 * yield* Azure.Synapse.WorkspaceRoleAssignment("AppPublishes", {
 *   workspace: workspace.workspaceName,
 *   roleId: Azure.Synapse.SynapseRole.ArtifactPublisher,
 *   principalId: app.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceRoleAssignment = Resource<WorkspaceRoleAssignment>(
  "Azure.Synapse.WorkspaceRoleAssignment",
);

/** Development endpoint of a workspace in the public cloud. */
export const synapseDevEndpoint = (workspace: string) =>
  `https://${workspace}.dev.azuresynapse.net`;

const scopeOf = (props: WorkspaceRoleAssignmentProps) =>
  props.scope ?? `workspaces/${props.workspace}`;

/** Read an assignment, `undefined` once it is gone. */
const getAssignment = (workspace: string, roleAssignmentId: string) =>
  syms.GetRoleAssignmentById({ endpoint: synapseDevEndpoint(workspace), roleAssignmentId }).pipe(
    Effect.map((a): syms.RoleAssignmentDetails | undefined => a),
    Effect.catchTag("RoleAssignmentNotFound", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  roleAssignmentId: string,
  props: WorkspaceRoleAssignmentProps,
): WorkspaceRoleAssignment["Attributes"] => ({
  roleAssignmentId,
  workspaceName: props.workspace,
  roleId: props.roleId,
  principalId: props.principalId,
  scope: scopeOf(props),
});

export const WorkspaceRoleAssignmentProvider = () =>
  Provider.succeed(WorkspaceRoleAssignment, {
    stables: ["roleAssignmentId", "workspaceName", "roleId", "principalId", "scope"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Every prop is part of the assignment's identity.
      if (
        !("workspace" in news) ||
        !("principalId" in news) ||
        !isResolved(news.workspace) ||
        !isResolved(news.principalId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<WorkspaceRoleAssignmentProps>(news)) return undefined;
      if (
        news.workspace !== output.workspaceName ||
        news.roleId.toLowerCase() !== output.roleId.toLowerCase() ||
        news.principalId.toLowerCase() !== output.principalId.toLowerCase() ||
        scopeOf(news) !== output.scope
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const props: WorkspaceRoleAssignmentProps | undefined =
        output !== undefined
          ? {
              workspace: output.workspaceName,
              roleId: output.roleId,
              principalId: output.principalId,
              scope: output.scope,
            }
          : olds;
      if (props === undefined) return undefined;
      const roleAssignmentId =
        output?.roleAssignmentId ?? (yield* deterministicGuid(id, instanceId));
      const observed = yield* getAssignment(props.workspace, roleAssignmentId);
      if (observed === undefined) return undefined;
      return toAttrs(roleAssignmentId, {
        workspace: props.workspace,
        roleId: observed.roleDefinitionId ?? props.roleId,
        principalId: observed.principalId ?? props.principalId,
        scope: observed.scope ?? scopeOf(props),
      });
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const roleAssignmentId =
        output?.roleAssignmentId ?? (yield* deterministicGuid(id, instanceId));
      const endpoint = synapseDevEndpoint(news.workspace);
      // Observe: an assignment is immutable, so one that exists is ours as is.
      const observed = yield* getAssignment(news.workspace, roleAssignmentId);
      if (observed === undefined) {
        yield* syms.CreateRoleAssignment({
          endpoint,
          roleAssignmentId,
          roleId: news.roleId,
          principalId: news.principalId,
          scope: scopeOf(news),
          principalType: news.principalType,
        });
      }
      return toAttrs(roleAssignmentId, news);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* syms
        .DeleteRoleAssignmentById({
          endpoint: synapseDevEndpoint(output.workspaceName),
          roleAssignmentId: output.roleAssignmentId,
          scope: output.scope,
        })
        .pipe(Effect.catchTag("RoleAssignmentNotFound", () => Effect.void));
    }),
  });
