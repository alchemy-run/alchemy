import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
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
import { getAccount } from "./Account.ts";
import {
  ACCOUNT_BUDGET,
  type CognitiveServicesIdentity,
  createChildName,
  identityDiffers,
  sameArm,
  toIdentityInput,
  whileAccountBusy,
} from "./Common.ts";

export interface ProjectProps {
  /** Resource group of the account. Changing it replaces the project. */
  resourceGroup: string;
  /**
   * Account that holds the project: kind `AIServices` with
   * `allowProjectManagement: true`. Changing it replaces the project.
   */
  account: string;
  /**
   * Project name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the project.
   */
  name?: string;
  /**
   * Location of the project; it must equal the account's location.
   * Changing it replaces the project.
   * @default the account's location
   */
  location?: string;
  /**
   * Managed identity of the project.
   * @default { type: "SystemAssigned" }
   */
  identity?: CognitiveServicesIdentity;
  /** Display name shown in the Azure AI Foundry portal. */
  displayName?: string;
  /** Description of the project. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Project extends Resource<
  "Azure.CognitiveServices.Project",
  ProjectProps,
  {
    /** Name of the project. */
    projectName: string;
    /** Account that holds the project. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the project; use it as a role-assignment scope. */
    projectId: string;
    /** Location of the project. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /**
     * Endpoints by API name, e.g. `AI Foundry API` →
     * `https://{subdomain}.services.ai.azure.com/api/projects/{name}`.
     */
    endpoints: Record<string, string>;
    /** Whether this is the account's default project. */
    isDefault: boolean;
    /** Object ID of the project's system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure AI Foundry project (`Microsoft.CognitiveServices/accounts/projects`):
 * a container for agents, connections, evaluations, and access control
 * inside an `AIServices` account.
 *
 * The parent account must have `allowProjectManagement: true` and a custom
 * subdomain (Alchemy sets the subdomain by default).
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects
 *
 * ### Creating a Project
 * **Example:** Foundry account and project
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("foundry", {
 *   resourceGroup: group.resourceGroupName,
 *   allowProjectManagement: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * const project = yield* Azure.CognitiveServices.Project("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   displayName: "Agents",
 * });
 * ```
 *
 * @resource
 */
export const Project = Resource<Project>("Azure.CognitiveServices.Project");

type ObservedProject = cognitiveservices.GetProjectResponse;

export const getProject = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  projectName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetProject({
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  project: ObservedProject,
): Project["Attributes"] => ({
  projectName: name,
  account,
  resourceGroup,
  projectId: project.id ?? "",
  location: project.location ?? "",
  displayName: project.properties?.displayName,
  description: project.properties?.description,
  endpoints: Object.fromEntries(
    Object.entries(project.properties?.endpoints ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  isDefault: project.properties?.isDefault ?? false,
  principalId: project.identity?.principalId,
  tags: userTags(project.tags),
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: [
      "projectName",
      "account",
      "resourceGroup",
      "projectId",
      "location",
    ],

    // Projects live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined && !sameArm(news.name, output.projectName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.projectName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getProject(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.projectName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const identity = news.identity ?? { type: "SystemAssigned" as const };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        projectName: name,
      };
      const label = `foundry project ${name}`;
      const get = getProject(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Projects are created in the account's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getAccount(subscriptionId, resourceGroup, account))?.location;
        yield* cognitiveservices
          .CreateProject({
            ...where,
            location,
            identity: toIdentityInput(identity),
            tags,
            properties: {
              displayName: news.displayName,
              description: news.description,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (project) => project.properties?.provisioningState,
        ACCOUNT_BUDGET,
      );

      // Sync display name, description, identity, and tags.
      const props = observed.properties ?? {};
      const changed: cognitiveservices.ProjectPropertiesInput = {};
      if (
        news.displayName !== undefined &&
        props.displayName !== news.displayName
      ) {
        changed.displayName = news.displayName;
      }
      if (
        news.description !== undefined &&
        props.description !== news.description
      ) {
        changed.description = news.description;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, identity);
      if (Object.keys(changed).length > 0 || tagsChanged || identityChanged) {
        yield* cognitiveservices
          .UpdateProject({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? toIdentityInput(identity) : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          (project) => project.properties?.provisioningState,
          ACCOUNT_BUDGET,
        );
      }

      return toAttrs(resourceGroup, account, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteProject({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            projectName: output.projectName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `foundry project ${output.projectName}`,
        getProject(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.projectName,
        ),
        ACCOUNT_BUDGET,
      );
    }),
  });
