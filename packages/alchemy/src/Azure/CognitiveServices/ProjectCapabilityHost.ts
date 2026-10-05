import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
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
import { isAccountOwnedByStack } from "./Account.ts";
import {
  ACCOUNT_BUDGET,
  createChildName,
  sameArm,
  sameValue,
  whileAccountBusy,
} from "./Common.ts";

export interface ProjectCapabilityHostProps {
  /** Resource group of the account. Changing it replaces the host. */
  resourceGroup: string;
  /** Account that holds the project. Changing it replaces the host. */
  account: string;
  /** Project that holds the host. Changing it replaces the host. */
  project: string;
  /**
   * Capability host name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the host.
   */
  name?: string;
  /** Names of connections to Azure AI services / Azure OpenAI used by agents. */
  aiServicesConnections?: string[];
  /** Names of Azure Storage connections for agent files (standard setup). */
  storageConnections?: string[];
  /** Names of Cosmos DB connections for agent threads (standard setup). */
  threadStorageConnections?: string[];
  /** Names of Azure AI Search connections for vector stores (standard setup). */
  vectorStoreConnections?: string[];
}

export interface ProjectCapabilityHost extends Resource<
  "Azure.CognitiveServices.ProjectCapabilityHost",
  ProjectCapabilityHostProps,
  {
    /** Name of the capability host. */
    capabilityHostName: string;
    /** ARM resource ID of the capability host. */
    capabilityHostId: string;
    /** Account that holds the project. */
    account: string;
    /** Project that holds the host. */
    project: string;
    /** Resource group of the account. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A project-level capability host
 * (`Microsoft.CognitiveServices/accounts/projects/capabilityHosts`) that
 * enables the Azure AI Foundry Agent Service for one project and chooses
 * where agent data lives: Microsoft-managed storage when no connections are
 * listed ("basic setup"), or the project's Storage, Cosmos DB, and AI
 * Search connections ("standard setup").
 *
 * The account needs its own `CognitiveServices.CapabilityHost` first;
 * otherwise Azure answers "Foundry Account capabilityHost Not Found". Pass
 * the account name from that host (`accountHost.account`) so the project
 * host deploys after it.
 *
 * Capability hosts cannot be updated: every property change replaces the
 * host. They carry no tags, so ownership follows the parent account's
 * Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/agents/concepts/capability-hosts
 *
 * ### Enabling Agents in a Project
 * **Example:** Basic setup
 * ```typescript
 * const accountHost = yield* Azure.CognitiveServices.CapabilityHost("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * yield* Azure.CognitiveServices.ProjectCapabilityHost("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   account: accountHost.account,
 *   project: project.projectName,
 * });
 * ```
 *
 * **Example:** Standard setup with project connections
 * ```typescript
 * yield* Azure.CognitiveServices.ProjectCapabilityHost("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   account: accountHost.account,
 *   project: project.projectName,
 *   storageConnections: [storage.connectionName],
 *   threadStorageConnections: [cosmos.connectionName],
 *   vectorStoreConnections: [search.connectionName],
 * });
 * ```
 *
 * @resource
 */
export const ProjectCapabilityHost = Resource<ProjectCapabilityHost>(
  "Azure.CognitiveServices.ProjectCapabilityHost",
);

const getHost = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  projectName: string,
  capabilityHostName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetProjectCapabilityHost({
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName,
      capabilityHostName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  project: string,
  name: string,
  host: cognitiveservices.GetProjectCapabilityHostResponse,
): ProjectCapabilityHost["Attributes"] => ({
  capabilityHostName: name,
  capabilityHostId: host.id ?? "",
  account,
  project,
  resourceGroup,
});

const sortedOrEmpty = (list: ReadonlyArray<string> | null | undefined) =>
  [...(list ?? [])].sort();

export const ProjectCapabilityHostProvider = () =>
  Provider.succeed(ProjectCapabilityHost, {
    stables: [
      "capabilityHostName",
      "capabilityHostId",
      "account",
      "project",
      "resourceGroup",
    ],

    // Capability hosts live inside a project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    // Capability hosts are not updatable: any change replaces the host.
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        !sameArm(news.project, output.project) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.capabilityHostName))
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const settings = (p: ProjectCapabilityHostProps) => ({
          aiServicesConnections: sortedOrEmpty(p.aiServicesConnections),
          storageConnections: sortedOrEmpty(p.storageConnections),
          threadStorageConnections: sortedOrEmpty(p.threadStorageConnections),
          vectorStoreConnections: sortedOrEmpty(p.vectorStoreConnections),
        });
        // An explicit name stays the same across the replacement, and an
        // account holds a single agents capability host: delete first.
        if (!sameValue(settings(olds), settings(news))) {
          return { action: "replace", deleteFirst: true } as const;
        }
      }
      return undefined;
    }),

    // Project capability hosts carry no tags; ownership follows the account.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const project = output?.project ?? olds?.project;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        project === undefined
      ) {
        return undefined;
      }
      const name =
        output?.capabilityHostName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getHost(
        subscriptionId,
        resourceGroup,
        account,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, project, name, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account, project } = news;
      const name =
        news.name ?? output?.capabilityHostName ?? (yield* createChildName(id));
      const get = getHost(
        subscriptionId,
        resourceGroup,
        account,
        project,
        name,
      );

      // Observe; a host is created once and never updated in place.
      const observed = yield* get;
      if (observed === undefined) {
        yield* cognitiveservices
          .ProjectCapabilityHostsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            projectName: project,
            capabilityHostName: name,
            properties: {
              aiServicesConnections: news.aiServicesConnections,
              storageConnections: news.storageConnections,
              threadStorageConnections: news.threadStorageConnections,
              vectorStoreConnections: news.vectorStoreConnections,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `project capability host ${name}`,
        get,
        (host) => host.properties.provisioningState,
        ACCOUNT_BUDGET,
      );
      return toAttrs(resourceGroup, account, project, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteProjectCapabilityHost({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            projectName: output.project,
            capabilityHostName: output.capabilityHostName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `project capability host ${output.capabilityHostName}`,
        getHost(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.project,
          output.capabilityHostName,
        ),
        ACCOUNT_BUDGET,
      );
    }),
  });
