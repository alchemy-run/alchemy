import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  identityDiffers,
  sameArm,
  toIdentityInput,
  type DevCenterIdentity,
} from "./Common.ts";

export interface ProjectEnvironmentTypeProps {
  /** Resource group of the project. Changing it replaces the project environment type. */
  resourceGroup: string;
  /** Name of the project. Changing it replaces the project environment type. */
  project: string;
  /**
   * Name of the dev center `EnvironmentType` this project enables. It is
   * also the name of the project environment type. Changing it replaces
   * the project environment type.
   */
  environmentType: string;
  /**
   * Azure location of the project environment type. Changing it replaces
   * the project environment type.
   * @default the project's location
   */
  location?: string;
  /**
   * Subscription environments of this type deploy into, as
   * `/subscriptions/{subscriptionId}`. The dev center's identity needs
   * Owner (or Contributor and User Access Administrator) on it to deploy.
   */
  deploymentTargetId?: string;
  /**
   * Whether developers can create environments of this type.
   * @default "Enabled"
   */
  status?: "Enabled" | "Disabled";
  /** Display name of the project environment type. */
  displayName?: string;
  /**
   * Role definition IDs (GUIDs) granted to an environment's creator on the
   * environment's resource group.
   */
  creatorRoles?: string[];
  /**
   * Additional role assignments on every environment's resource group,
   * keyed by Entra object ID, valued by role definition IDs (GUIDs).
   */
  userRoleAssignments?: Record<string, string[]>;
  /** Managed identity used to deploy environments of this type. */
  identity?: DevCenterIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ProjectEnvironmentType extends Resource<
  "Azure.DevCenter.ProjectEnvironmentType",
  ProjectEnvironmentTypeProps,
  {
    /** Name of the project environment type (the environment type name). */
    environmentTypeName: string;
    /** ARM resource ID of the project environment type. */
    projectEnvironmentTypeId: string;
    /** Name of the project. */
    project: string;
    /** Resource group of the project. */
    resourceGroup: string;
    /** Location of the project environment type. */
    location: string | undefined;
    /** Deployment target subscription. */
    deploymentTargetId: string | undefined;
    /** Whether developers can create environments of this type. */
    status: string | undefined;
    /** Number of environments of this type in the project. */
    environmentCount: number | undefined;
    /** Object ID of the system-assigned identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A project environment type — enables a dev center `EnvironmentType` for
 * one project, and decides where environments of that type deploy and
 * which roles their creators get.
 *
 * @see https://learn.microsoft.com/azure/deployment-environments/how-to-configure-project-environment-types
 *
 * ### Enabling an Environment Type
 * **Example:** Deploy `dev` environments into the current subscription
 * ```typescript
 * const dev = yield* Azure.DevCenter.EnvironmentType("dev", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   name: "dev",
 * });
 * const projectDev = yield* Azure.DevCenter.ProjectEnvironmentType("project-dev", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
 *   environmentType: dev.environmentTypeName,
 *   deploymentTargetId: `/subscriptions/${subscriptionId}`,
 *   identity: { type: "SystemAssigned" },
 *   // Contributor for environment creators
 *   creatorRoles: ["b24988ac-6180-42a0-ab88-20f7382dd24c"],
 * });
 * ```
 *
 * **Example:** Temporarily disable an environment type
 * ```typescript
 * const projectDev = yield* Azure.DevCenter.ProjectEnvironmentType("project-dev", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
 *   environmentType: "dev",
 *   status: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const ProjectEnvironmentType = Resource<ProjectEnvironmentType>(
  "Azure.DevCenter.ProjectEnvironmentType",
);

type Observed = devcenter.GetProjectEnvironmentTypeResponse;

const getProjectEnvironmentType = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  environmentTypeName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetProjectEnvironmentType({
      subscriptionId,
      resourceGroupName,
      projectName,
      environmentTypeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  project: string,
  name: string,
  observed: Observed,
): ProjectEnvironmentType["Attributes"] => ({
  environmentTypeName: name,
  projectEnvironmentTypeId: observed.id ?? "",
  project,
  resourceGroup,
  location: observed.location,
  deploymentTargetId: observed.properties?.deploymentTargetId,
  status: observed.properties?.status,
  environmentCount: observed.properties?.environmentCount,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const roleMap = (roles: string[]) =>
  Object.fromEntries(roles.map((role) => [role, {}]));

const roleKeys = (map: Record<string, unknown> | undefined) =>
  Object.keys(map ?? {})
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");

const userRolesKey = (
  map: Record<string, { readonly roles?: Record<string, unknown> } | undefined>,
) =>
  Object.entries(map)
    .map(([principal, value]) => `${principal.toLowerCase()}=${roleKeys(value?.roles)}`)
    .sort()
    .join(";");

export const ProjectEnvironmentTypeProvider = () =>
  Provider.succeed(ProjectEnvironmentType, {
    stables: [
      "environmentTypeName",
      "projectEnvironmentTypeId",
      "project",
      "resourceGroup",
    ],

    // Project environment types live inside a project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.project, output.project) ||
        !sameArm(news.environmentType, output.environmentTypeName) ||
        (news.location !== undefined &&
          output.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const project = output?.project ?? olds?.project;
      const name = output?.environmentTypeName ?? olds?.environmentType;
      if (
        resourceGroup === undefined ||
        project === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getProjectEnvironmentType(
        subscriptionId,
        resourceGroup,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, project, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, project } = news;
      const name = news.environmentType;
      const tags = yield* desiredTags(id, news.tags);
      const status = news.status ?? "Enabled";
      const creatorRoleAssignment =
        news.creatorRoles === undefined
          ? undefined
          : { roles: roleMap(news.creatorRoles) };
      const userRoleAssignments =
        news.userRoleAssignments === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(news.userRoleAssignments).map(
                ([principal, roles]) => [principal, { roles: roleMap(roles) }],
              ),
            );
      const identity = toIdentityInput(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        projectName: project,
        environmentTypeName: name,
      };
      const label = `project environment type ${project}/${name}`;
      const get = getProjectEnvironmentType(
        subscriptionId,
        resourceGroup,
        project,
        name,
      );
      const stateOf = (observed: Observed) =>
        observed.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* devcenter.ProjectEnvironmentTypesCreateOrUpdate({
          ...where,
          location: news.location,
          tags,
          identity,
          properties: {
            deploymentTargetId: news.deploymentTargetId,
            displayName: news.displayName,
            status,
            creatorRoleAssignment,
            userRoleAssignments,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "3 seconds",
        times: 40,
      });

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const changed: devcenter.ProjectEnvironmentTypeUpdatePropertiesInput = {};
      if (
        news.deploymentTargetId !== undefined &&
        !sameArm(props?.deploymentTargetId, news.deploymentTargetId)
      ) {
        changed.deploymentTargetId = news.deploymentTargetId;
      }
      if (
        news.displayName !== undefined &&
        props?.displayName !== news.displayName
      ) {
        changed.displayName = news.displayName;
      }
      if (props?.status !== status) changed.status = status;
      if (
        creatorRoleAssignment !== undefined &&
        roleKeys(props?.creatorRoleAssignment?.roles) !==
          roleKeys(creatorRoleAssignment.roles)
      ) {
        changed.creatorRoleAssignment = creatorRoleAssignment;
      }
      if (
        userRoleAssignments !== undefined &&
        userRolesKey(props?.userRoleAssignments ?? {}) !==
          userRolesKey(userRoleAssignments)
      ) {
        changed.userRoleAssignments = userRoleAssignments;
      }
      const propsChanged = Object.keys(changed).length > 0;
      const identityChanged = identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || identityChanged || tagsChanged) {
        yield* devcenter.UpdateProjectEnvironmentType({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: propsChanged ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "3 seconds",
          times: 40,
        });
      }

      return toAttrs(resourceGroup, project, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter.DeleteProjectEnvironmentType({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.project,
          environmentTypeName: output.environmentTypeName,
        }),
      );
      yield* waitUntilGone(
        `project environment type ${output.project}/${output.environmentTypeName}`,
        getProjectEnvironmentType(
          subscriptionId,
          output.resourceGroup,
          output.project,
          output.environmentTypeName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.Project", "Azure.Resources.ResourceGroup"],
    },
  });
