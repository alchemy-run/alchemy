import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDevCenterName,
  devCenterOwnedByStage,
  sameArm,
  sameValue,
} from "./Common.ts";

/** One rule of a project policy. */
export interface ProjectPolicyResourcePolicy {
  /**
   * ID of an existing resource the rule applies to, e.g. an attached
   * network or image. Azure rejects wildcards and unknown IDs.
   */
  resources?: string;
  /** Filter expression over `resourceType`, e.g. a SKU name. */
  filter?: string;
  /** Whether matching resources are allowed or denied. */
  action?: "Allow" | "Deny";
  /** Kind of resource the filter applies to. */
  resourceType?: "Images" | "Skus" | "AttachedNetworks";
}

export interface ProjectPolicyProps {
  /** Resource group of the dev center. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the dev center. Changing it replaces the policy. */
  devCenter: string;
  /**
   * Policy name. A dev center's first policy must be named `default`;
   * others can only be created after it exists. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the policy.
   */
  name?: string;
  /**
   * Resources (images, SKUs, attached networks) the scoped projects may
   * use. Azure rejects an empty list.
   */
  resourcePolicies?: ProjectPolicyResourcePolicy[];
  /**
   * ARM resource IDs of the projects the policy applies to. Must be empty
   * for the `default` policy, which applies to every project.
   */
  scopes?: string[];
}

export interface ProjectPolicy extends Resource<
  "Azure.DevCenter.ProjectPolicy",
  ProjectPolicyProps,
  {
    /** Name of the policy. */
    projectPolicyName: string;
    /** ARM resource ID of the policy. */
    projectPolicyId: string;
    /** Name of the dev center. */
    devCenter: string;
    /** Resource group of the dev center. */
    resourceGroup: string;
    /** Observed resource policies. */
    resourcePolicies: ProjectPolicyResourcePolicy[];
    /** Observed project scopes. */
    scopes: string[];
  },
  never,
  Providers
> {}

/**
 * A dev center project policy — restricts which images, dev box SKUs, and
 * attached networks the projects in its scope may use.
 *
 * Project policies have no tags; Alchemy treats a policy as owned when
 * its dev center carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-configure-project-policy
 *
 * ### Restricting Projects
 * **Example:** A default policy plus a stricter policy for one project
 * ```typescript
 * // Every dev center needs a `default` policy (no scopes) before any other.
 * const defaults = yield* Azure.DevCenter.ProjectPolicy("default", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   name: "default",
 *   resourcePolicies: [{ resourceType: "Skus", action: "Allow" }],
 * });
 * const policy = yield* Azure.DevCenter.ProjectPolicy("policy", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: defaults.devCenter,
 *   scopes: [project.projectId],
 *   // `resources` must be the ID of an existing image or attached network;
 *   // wildcards are rejected.
 *   resourcePolicies: [{ resources: attached.attachedNetworkId }],
 * });
 * ```
 *
 * @resource
 */
export const ProjectPolicy = Resource<ProjectPolicy>(
  "Azure.DevCenter.ProjectPolicy",
);

type Observed = devcenter.GetProjectPolicyResponse;

const getProjectPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
  projectPolicyName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetProjectPolicy({
      subscriptionId,
      resourceGroupName,
      devCenterName,
      projectPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  devCenter: string,
  name: string,
  observed: Observed,
): ProjectPolicy["Attributes"] => ({
  projectPolicyName: name,
  projectPolicyId: observed.id ?? "",
  devCenter,
  resourceGroup,
  resourcePolicies: (observed.properties?.resourcePolicies ??
    []) as ProjectPolicyResourcePolicy[],
  scopes: [...(observed.properties?.scopes ?? [])],
});

const lowerScopes = (scopes: readonly string[] | undefined) =>
  (scopes ?? []).map((scope) => scope.toLowerCase()).sort();

export const ProjectPolicyProvider = () =>
  Provider.succeed(ProjectPolicy, {
    stables: ["projectPolicyName", "projectPolicyId", "devCenter", "resourceGroup"],

    // Project policies live inside a dev center; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenter, output.devCenter) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.projectPolicyName))
      ) {
        // A project can be in the scope of only one policy, so the
        // replacement cannot coexist with the old policy.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const devCenter = output?.devCenter ?? olds?.devCenter;
      if (resourceGroup === undefined || devCenter === undefined) {
        return undefined;
      }
      const name =
        output?.projectPolicyName ??
        olds?.name ??
        (yield* createDevCenterName(id));
      const observed = yield* getProjectPolicy(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, devCenter, name, observed);
      return (yield* devCenterOwnedByStage(
        subscriptionId,
        resourceGroup,
        devCenter,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, devCenter } = news;
      const name =
        news.name ??
        output?.projectPolicyName ??
        (yield* createDevCenterName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        devCenterName: devCenter,
        projectPolicyName: name,
      };
      const label = `project policy ${name}`;
      const get = getProjectPolicy(subscriptionId, resourceGroup, devCenter, name);
      const stateOf = (observed: Observed) =>
        observed.properties?.provisioningState;
      const resourcePolicies = news.resourcePolicies ?? [];
      const scopes = news.scopes ?? [];

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* devcenter.ProjectPoliciesCreateOrUpdate({
          ...where,
          properties: { resourcePolicies, scopes },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "3 seconds",
        times: 60,
      });

      // Sync policies and scopes against observed state.
      const policiesChanged = !sameValue(
        observed.properties?.resourcePolicies ?? [],
        resourcePolicies,
      );
      const scopesChanged = !sameValue(
        lowerScopes(observed.properties?.scopes),
        lowerScopes(scopes),
      );
      if (policiesChanged || scopesChanged) {
        yield* devcenter.UpdateProjectPolicy({
          ...where,
          properties: {
            resourcePolicies: policiesChanged ? resourcePolicies : undefined,
            scopes: scopesChanged ? scopes : undefined,
          },
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "3 seconds",
          times: 60,
        });
      }

      return toAttrs(resourceGroup, devCenter, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter.DeleteProjectPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          devCenterName: output.devCenter,
          projectPolicyName: output.projectPolicyName,
        }),
      );
      yield* waitUntilGone(
        `project policy ${output.projectPolicyName}`,
        getProjectPolicy(
          subscriptionId,
          output.resourceGroup,
          output.devCenter,
          output.projectPolicyName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
