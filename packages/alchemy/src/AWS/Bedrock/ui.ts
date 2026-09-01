import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Agent } from "./Agent.ts";
import type { AgentAlias } from "./AgentAlias.ts";
import type { DataSource } from "./DataSource.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";

/**
 * Dashboard UI providers for AWS Bedrock resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const AgentUI = UIProvider.succeed<Agent>("AWS.Bedrock.Agent", {
  displayName: "Bedrock Agent",
  icon: "bot",
  color: "#01A88D",
  category: "ai",
  summary: (ctx) => ctx.attrs?.agentName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.agentArn);
    return ctx.attrs?.agentId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/bedrock/home?region=${region}#/agents/${ctx.attrs.agentId}`;
  },
  facts: (ctx) => [
    { label: "agent", value: ctx.attrs?.agentName, copy: true },
    { label: "id", value: ctx.attrs?.agentId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.agentArn, mono: true, copy: true },
    { label: "version", value: ctx.attrs?.agentVersion },
    { label: "role", value: ctx.attrs?.agentResourceRoleArn, mono: true },
    { label: "model", value: ctx.props?.foundationModel },
  ],
});

export const AgentAliasUI = UIProvider.succeed<AgentAlias>(
  "AWS.Bedrock.AgentAlias",
  {
    displayName: "Bedrock Agent Alias",
    icon: "tag",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.agentAliasName,
    facts: (ctx) => [
      { label: "alias", value: ctx.attrs?.agentAliasName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.agentAliasArn,
        mono: true,
        copy: true,
      },
      { label: "agent", value: ctx.attrs?.agentId, mono: true },
    ],
  },
);

export const DataSourceUI = UIProvider.succeed<DataSource>(
  "AWS.Bedrock.DataSource",
  {
    displayName: "Bedrock Data Source",
    icon: "folder",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "source", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.dataSourceId, mono: true, copy: true },
      {
        label: "knowledge base",
        value: ctx.attrs?.knowledgeBaseId,
        mono: true,
      },
    ],
  },
);

export const KnowledgeBaseUI = UIProvider.succeed<KnowledgeBase>(
  "AWS.Bedrock.KnowledgeBase",
  {
    displayName: "Bedrock Knowledge Base",
    icon: "brain",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.knowledgeBaseArn);
      return ctx.attrs?.knowledgeBaseId === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/bedrock/home?region=${region}#/knowledge-bases/${ctx.attrs.knowledgeBaseId}`;
    },
    facts: (ctx) => [
      { label: "knowledge base", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.knowledgeBaseId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.knowledgeBaseArn,
        mono: true,
        copy: true,
      },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(AgentUI, AgentAliasUI, DataSourceUI, KnowledgeBaseUI);
