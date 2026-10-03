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

export interface AgentDeploymentAgent {
  /** Name of the Foundry agent. */
  agentName: string;
  /** Agent version to deploy. */
  agentVersion: string;
  /** ID of the Foundry agent. */
  agentId?: string;
}

export interface AgentDeploymentProtocol {
  /** Protocol the deployment serves: `Agent`, `A2A`, or `Responses`. */
  protocol: "Agent" | "A2A" | "Responses";
  /** Protocol version. */
  version?: string;
}

export interface AgentDeploymentProps {
  /** Resource group of the account. Changing it replaces the deployment. */
  resourceGroup: string;
  /** Account that holds the project. Changing it replaces the deployment. */
  account: string;
  /** Project that holds the application. Changing it replaces the deployment. */
  project: string;
  /** Agent application that holds the deployment. Changing it replaces the deployment. */
  application: string;
  /**
   * Deployment name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the deployment.
   */
  name?: string;
  /** How the agents are hosted. Changing it replaces the deployment. */
  deploymentType: "Managed" | "Hosted" | "Custom";
  /** Agent versions to deploy. */
  agents: AgentDeploymentAgent[];
  /** Protocols the deployment serves. */
  protocols?: AgentDeploymentProtocol[];
  /** Display name. */
  displayName?: string;
  /** Description. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AgentDeployment extends Resource<
  "Azure.CognitiveServices.AgentDeployment",
  AgentDeploymentProps,
  {
    /** Name of the deployment. */
    deploymentName: string;
    /** ARM resource ID of the deployment. */
    agentDeploymentId: string;
    /** Account that holds the project. */
    account: string;
    /** Project that holds the application. */
    project: string;
    /** Agent application that holds the deployment. */
    application: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Hosting type. */
    deploymentType: string;
    /** Runtime state (`Running`, `Stopped`, ...). */
    state: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A deployment of agent versions into an agent application
 * (`Microsoft.CognitiveServices/accounts/projects/applications/agentDeployments`,
 * preview), served over the Agent, A2A, or Responses protocols.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/agents/overview
 *
 * ### Deploying Agents
 * **Example:** Managed deployment of one agent version
 * ```typescript
 * yield* Azure.CognitiveServices.AgentDeployment("prod", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   project: project.projectName,
 *   application: app.applicationName,
 *   deploymentType: "Managed",
 *   agents: [{ agentName: "support-agent", agentVersion: "3" }],
 *   protocols: [{ protocol: "Responses" }],
 * });
 * ```
 *
 * @resource
 */
export const AgentDeployment = Resource<AgentDeployment>(
  "Azure.CognitiveServices.AgentDeployment",
);

const getDeployment = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  projectName: string,
  appName: string,
  deploymentName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetAgentDeployment({
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName,
      appName,
      deploymentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  project: string,
  application: string,
  name: string,
  deployment: cognitiveservices.GetAgentDeploymentResponse,
): AgentDeployment["Attributes"] => ({
  deploymentName: name,
  agentDeploymentId: deployment.id ?? "",
  account,
  project,
  application,
  resourceGroup,
  deploymentType: deployment.properties.deploymentType,
  state: deployment.properties.state ?? undefined,
  tags: userTags(deployment.properties.tags ?? undefined),
});

const agentsKey = (
  agents:
    | ReadonlyArray<{
        readonly agentName?: string | null;
        readonly agentVersion?: string | null;
        readonly agentId?: string | null;
      }>
    | null
    | undefined,
) =>
  [...(agents ?? [])]
    .map((a) => `${a.agentName ?? ""}@${a.agentVersion ?? ""}`)
    .sort();

const protocolsKey = (
  protocols:
    | ReadonlyArray<{
        readonly protocol?: string;
        readonly version?: string | null;
      }>
    | null
    | undefined,
) =>
  [...(protocols ?? [])]
    .map((p) => `${p.protocol ?? ""}@${p.version ?? ""}`)
    .sort();

export const AgentDeploymentProvider = () =>
  Provider.succeed(AgentDeployment, {
    stables: [
      "deploymentName",
      "agentDeploymentId",
      "account",
      "project",
      "application",
      "resourceGroup",
      "deploymentType",
    ],

    // Deployments live inside an application; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        !sameArm(news.project, output.project) ||
        !sameArm(news.application, output.application) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.deploymentName)) ||
        news.deploymentType !== output.deploymentType
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
      const application = output?.application ?? olds?.application;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        project === undefined ||
        application === undefined
      ) {
        return undefined;
      }
      const name =
        output?.deploymentName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDeployment(
        subscriptionId,
        resourceGroup,
        account,
        project,
        application,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        project,
        application,
        name,
        observed,
      );
      return (yield* isOwned(id, observed.properties.tags ?? undefined))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account, project, application } = news;
      const name =
        news.name ?? output?.deploymentName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getDeployment(
        subscriptionId,
        resourceGroup,
        account,
        project,
        application,
        name,
      );

      // Observe; the PUT (LRO) is a full upsert sent only on a delta.
      const observed = yield* get;
      const props = observed?.properties;
      if (
        observed === undefined ||
        !sameValue(agentsKey(props?.agents), agentsKey(news.agents)) ||
        (news.protocols !== undefined &&
          !sameValue(
            protocolsKey(props?.protocols),
            protocolsKey(news.protocols),
          )) ||
        (news.displayName !== undefined &&
          props?.displayName !== news.displayName) ||
        (news.description !== undefined &&
          props?.description !== news.description) ||
        tagsDiffer(props?.tags ?? undefined, tags)
      ) {
        yield* cognitiveservices
          .AgentDeploymentsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            projectName: project,
            appName: application,
            deploymentName: name,
            properties: {
              deploymentType: news.deploymentType,
              agents: news.agents,
              protocols: news.protocols,
              displayName: news.displayName,
              description: news.description,
              tags,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `agent deployment ${name}`,
        get,
        (deployment) => deployment.properties.provisioningState,
        ACCOUNT_BUDGET,
      );
      return toAttrs(resourceGroup, account, project, application, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteAgentDeployment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            projectName: output.project,
            appName: output.application,
            deploymentName: output.deploymentName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `agent deployment ${output.deploymentName}`,
        getDeployment(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.project,
          output.application,
          output.deploymentName,
        ),
        ACCOUNT_BUDGET,
      );
    }),
  });
