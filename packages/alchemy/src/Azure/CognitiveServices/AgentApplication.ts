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
import {
  ACCOUNT_BUDGET,
  createChildName,
  sameArm,
  sameValue,
  whileAccountBusy,
} from "./Common.ts";

export interface AgentApplicationAgent {
  /** Name of a Foundry agent in the project. */
  agentName?: string;
  /** ID of a Foundry agent in the project. */
  agentId?: string;
}

export interface AgentApplicationProps {
  /** Resource group of the account. Changing it replaces the application. */
  resourceGroup: string;
  /** Account that holds the project. Changing it replaces the application. */
  account: string;
  /** Project that holds the application. Changing it replaces the application. */
  project: string;
  /**
   * Application name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the application.
   */
  name?: string;
  /** Display name. */
  displayName?: string;
  /** Description. */
  description?: string;
  /**
   * Agents (authored in the Foundry project) the application exposes; at
   * least one is required.
   */
  agents: AgentApplicationAgent[];
  /** Base URL of the application. */
  baseUrl?: string;
  /**
   * Who may call the application.
   * @default Azure's default (`Default`)
   */
  authorizationPolicy?: "Default" | "OrganizationScope" | "Channels" | "Custom";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AgentApplication extends Resource<
  "Azure.CognitiveServices.AgentApplication",
  AgentApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** ARM resource ID of the application. */
    applicationId: string;
    /** Account that holds the project. */
    account: string;
    /** Project that holds the application. */
    project: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Base URL of the application. */
    baseUrl: string | undefined;
    /** Whether the application is enabled. */
    isEnabled: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An agent application (`Microsoft.CognitiveServices/accounts/projects/applications`,
 * preview) that publishes Foundry agents of a project behind a stable
 * endpoint with its own identity and authorization policy. Deploy agent
 * versions into it with `CognitiveServices.AgentDeployment`.
 *
 * The agents must already exist in the project (they are authored through
 * the Foundry data plane); Azure rejects an application without agents.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/agents/overview
 *
 * ### Publishing Agents
 * **Example:** Application exposing one agent
 * ```typescript
 * const app = yield* Azure.CognitiveServices.AgentApplication("support", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   project: project.projectName,
 *   displayName: "Customer support",
 *   agents: [{ agentName: "support-agent" }],
 * });
 * ```
 *
 * @resource
 */
export const AgentApplication = Resource<AgentApplication>(
  "Azure.CognitiveServices.AgentApplication",
);

export const getAgentApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  projectName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetAgentApplication({
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  project: string,
  name: string,
  app: cognitiveservices.GetAgentApplicationResponse,
): AgentApplication["Attributes"] => ({
  applicationName: name,
  applicationId: app.id ?? "",
  account,
  project,
  resourceGroup,
  baseUrl: app.properties.baseUrl ?? undefined,
  isEnabled: app.properties.isEnabled,
  tags: userTags(app.properties.tags ?? undefined),
});

const agentsKey = (
  agents:
    | ReadonlyArray<{
        readonly agentName?: string | null;
        readonly agentId?: string | null;
      }>
    | null
    | undefined,
) =>
  [...(agents ?? [])]
    .map((agent) => ({
      agentName: agent.agentName ?? undefined,
      agentId: agent.agentId ?? undefined,
    }))
    .sort((a, b) =>
      `${a.agentName}|${a.agentId}`.localeCompare(
        `${b.agentName}|${b.agentId}`,
      ),
    );

export const AgentApplicationProvider = () =>
  Provider.succeed(AgentApplication, {
    stables: [
      "applicationName",
      "applicationId",
      "account",
      "project",
      "resourceGroup",
    ],

    // Applications live inside a project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        !sameArm(news.project, output.project) ||
        (news.name !== undefined && !sameArm(news.name, output.applicationName))
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
        output?.applicationName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getAgentApplication(
        subscriptionId,
        resourceGroup,
        account,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, project, name, observed);
      return (yield* isOwned(id, observed.properties.tags ?? undefined))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account, project } = news;
      const name =
        news.name ?? output?.applicationName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getAgentApplication(
        subscriptionId,
        resourceGroup,
        account,
        project,
        name,
      );

      // Observe; the PUT (LRO) is a full upsert sent only on a delta.
      const observed = yield* get;
      const props = observed?.properties;
      if (
        observed === undefined ||
        (news.displayName !== undefined &&
          props?.displayName !== news.displayName) ||
        (news.description !== undefined &&
          props?.description !== news.description) ||
        (news.baseUrl !== undefined && props?.baseUrl !== news.baseUrl) ||
        (news.authorizationPolicy !== undefined &&
          props?.authorizationPolicy?.type !== news.authorizationPolicy) ||
        !sameValue(agentsKey(props?.agents), agentsKey(news.agents)) ||
        tagsDiffer(props?.tags ?? undefined, tags)
      ) {
        yield* cognitiveservices
          .AgentApplicationsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            projectName: project,
            name,
            properties: {
              displayName: news.displayName,
              description: news.description,
              agents: news.agents,
              baseUrl: news.baseUrl,
              authorizationPolicy:
                news.authorizationPolicy === undefined
                  ? undefined
                  : { type: news.authorizationPolicy },
              tags,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `agent application ${name}`,
        get,
        (app) => app.properties.provisioningState,
        ACCOUNT_BUDGET,
      );
      return toAttrs(resourceGroup, account, project, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteAgentApplication({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            projectName: output.project,
            name: output.applicationName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `agent application ${output.applicationName}`,
        getAgentApplication(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.project,
          output.applicationName,
        ),
        ACCOUNT_BUDGET,
      );
    }),
  });
