import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CHILD_BUDGET,
  createChildName,
  sameArm,
  whileAccountBusy,
} from "./Common.ts";
import {
  type ConnectionAttrs,
  type ConnectionSettings,
  connectionAttrs,
  connectionMatches,
  desiredConnection,
} from "./ConnectionShared.ts";

export interface ProjectConnectionProps extends ConnectionSettings {
  /** Resource group of the account. Changing it replaces the connection. */
  resourceGroup: string;
  /** Account that holds the project. Changing it replaces the connection. */
  account: string;
  /** Project that holds the connection. Changing it replaces the connection. */
  project: string;
  /**
   * Connection name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
}

export interface ProjectConnection extends Resource<
  "Azure.CognitiveServices.ProjectConnection",
  ProjectConnectionProps,
  ConnectionAttrs & {
    /** Account that holds the project. */
    account: string;
    /** Project that holds the connection. */
    project: string;
    /** Resource group of the account. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A project-level connection
 * (`Microsoft.CognitiveServices/accounts/projects/connections`) to an
 * external resource — Azure AI Search, Storage, Cosmos DB, Key Vault, or
 * any API protected by keys — visible only inside one Azure AI Foundry
 * project. Use `CognitiveServices.Connection` to share a connection with
 * every project of the account.
 *
 * Connections have no tags, so Alchemy records ownership in the
 * connection metadata. Credentials are write-only; Alchemy stores a hash of
 * them in metadata to detect changes.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/how-to/connections-add
 *
 * ### Creating a Connection
 * **Example:** API key connection
 * ```typescript
 * const search = yield* Azure.CognitiveServices.ProjectConnection("search", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   project: project.projectName,
 *   category: "ApiKey",
 *   authType: "ApiKey",
 *   target: "https://api.example.com",
 *   credentials: { key: yield* Config.redacted("EXAMPLE_API_KEY") },
 * });
 * ```
 *
 * **Example:** Managed-identity connection to Azure AI Search
 * ```typescript
 * const search = yield* Azure.CognitiveServices.ProjectConnection("search", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   project: project.projectName,
 *   category: "CognitiveSearch",
 *   authType: "AAD",
 *   target: "https://my-search.search.windows.net",
 *   metadata: { ApiType: "Azure", ResourceId: searchServiceId },
 * });
 * ```
 *
 * @resource
 */
export const ProjectConnection = Resource<ProjectConnection>(
  "Azure.CognitiveServices.ProjectConnection",
);

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  projectName: string,
  connectionName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetProjectConnection({
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName,
      connectionName,
    }),
  );

export const ProjectConnectionProvider = () =>
  Provider.succeed(ProjectConnection, {
    stables: [
      "connectionName",
      "connectionId",
      "account",
      "project",
      "resourceGroup",
    ],

    // Connections live inside a project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        !sameArm(news.project, output.project) ||
        (news.name !== undefined && !sameArm(news.name, output.connectionName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

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
        output?.connectionName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        account,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = {
        ...connectionAttrs(name, observed),
        account,
        project,
        resourceGroup,
      };
      return (yield* isOwned(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account, project } = news;
      const name =
        news.name ?? output?.connectionName ?? (yield* createChildName(id));
      const properties = yield* desiredConnection(id, news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        projectName: project,
        connectionName: name,
      };
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        account,
        project,
        name,
      );

      // Observe; then ensure + sync with one synchronous upsert when the
      // connection is missing or differs.
      const observed = yield* get;
      if (
        observed === undefined ||
        !connectionMatches(observed.properties, properties)
      ) {
        yield* cognitiveservices
          .CreateProjectConnection({
            ...where,
            properties,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `connection ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return {
        ...connectionAttrs(name, fresh),
        account,
        project,
        resourceGroup,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteProjectConnection({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            projectName: output.project,
            connectionName: output.connectionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.project,
          output.connectionName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
