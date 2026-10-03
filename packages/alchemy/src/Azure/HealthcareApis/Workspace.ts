import * as healthcareapis from "@distilled.cloud/azure/healthcareapis";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createHealthcareName,
  sameArm,
  whileChildrenExist,
  WORKSPACE_BUDGET,
  desiredMarkerTags,
  hasAnyMarker,
  markerTagsDiffer,
  ownsMarkerTags,
  userMarkerTags,
} from "./Common.ts";

export interface WorkspaceProps {
  /**
   * Resource group the workspace is created in. Changing it replaces the
   * workspace.
   */
  resourceGroup: string;
  /**
   * Globally unique workspace name: 3-24 lowercase letters and digits,
   * starting with a letter. It prefixes the host names of the workspace's
   * FHIR and DICOM services. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location of the workspace. Its FHIR and DICOM services live in
   * the same location. Changing it replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership markers (`alchemy_stack`, `alchemy_stage`,
   * `alchemy_id`) are merged in automatically; this resource provider
   * rejects `:` in tag names.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.HealthcareApis.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** Location of the workspace. */
    location: string;
    /**
     * Whether data-plane traffic from public networks is allowed
     * (`Enabled` / `Disabled`); Azure manages it from private endpoints.
     */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership markers stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Health Data Services workspace — the logical container for FHIR
 * and DICOM services that share a location, network and compliance
 * boundary. A workspace itself is free; you pay for the services in it.
 *
 * @see https://learn.microsoft.com/azure/healthcare-apis/workspace-overview
 *
 * ### Creating a Workspace
 * **Example:** Workspace in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("health");
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Workspace with a fixed name and tags
 * ```typescript
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "contosohealth",
 *   location: "westus2",
 *   tags: { team: "clinical" },
 * });
 * ```
 *
 * ### Adding Services
 * **Example:** Workspace with a FHIR R4 service
 * ```typescript
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>("Azure.HealthcareApis.Workspace");

type ObservedWorkspace =
  | healthcareapis.GetWorkspaceResponse
  | healthcareapis.Workspace;

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    healthcareapis.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
): Workspace["Attributes"] => ({
  workspaceName: name,
  workspaceId: workspace.id ?? "",
  resourceGroup,
  location: workspace.location ?? "",
  publicNetworkAccess: workspace.properties?.publicNetworkAccess,
  tags: userMarkerTags(workspace.tags),
});

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "workspaceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* healthcareapis
        .ListWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkspaceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((workspace) => {
        const group = resourceGroupOf(workspace.id);
        return hasAnyMarker(workspace.tags) &&
          group !== undefined &&
          workspace.name !== undefined
          ? [toAttrs(group, workspace.name, workspace)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.workspaceName)) ||
        (news.location !== undefined &&
          !sameArm(
            news.location.replace(/\s/g, ""),
            output.location.replace(/\s/g, ""),
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.workspaceName ??
        olds?.name ??
        (yield* createHealthcareName(id));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* ownsMarkerTags(id, observed.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HealthcareApis");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workspaceName ?? (yield* createHealthcareName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredMarkerTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };
      const get = getWorkspace(subscriptionId, resourceGroup, name);
      const label = `Health Data Services workspace ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* healthcareapis.WorkspacesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {},
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (workspace) => workspace.properties?.provisioningState,
        WORKSPACE_BUDGET,
      );

      // Sync tags (the only mutable aspect) against observed tags.
      if (markerTagsDiffer(observed.tags, tags)) {
        yield* healthcareapis.UpdateWorkspace({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (workspace) =>
            markerTagsDiffer(workspace.tags, tags)
              ? "Updating"
              : workspace.properties?.provisioningState,
          WORKSPACE_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        healthcareapis
          .DeleteWorkspace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            workspaceName: output.workspaceName,
          })
          .pipe(Effect.retry(whileChildrenExist)),
      );
      yield* waitUntilGone(
        `Health Data Services workspace ${output.workspaceName}`,
        getWorkspace(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
        ),
        WORKSPACE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
