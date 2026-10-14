import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";
import type { Gateway } from "./Gateway.ts";
import type { Memory } from "./Memory.ts";
import type { Runtime } from "./Runtime.ts";

/**
 * Dashboard UI providers for AWS BedrockAgentCore resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Machine Learning & AI brand teal. */
const COLOR = "#01A88D";

export const BrowserCustomUI = UIProvider.succeed<BrowserCustom>(
  "AWS.BedrockAgentCore.BrowserCustom",
  {
    displayName: "AgentCore Browser",
    icon: "globe",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.browserId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.browserArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const CodeInterpreterUI = UIProvider.succeed<CodeInterpreter>(
  "AWS.BedrockAgentCore.CodeInterpreter",
  {
    displayName: "AgentCore Code Interpreter",
    icon: "terminal",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.codeInterpreterId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.codeInterpreterArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const GatewayUI = UIProvider.succeed<Gateway>(
  "AWS.BedrockAgentCore.Gateway",
  {
    displayName: "AgentCore Gateway",
    icon: "waypoints",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.gatewayUrl,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.gatewayId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.gatewayArn, mono: true, copy: true },
      {
        label: "url",
        value: ctx.attrs?.gatewayUrl,
        href: ctx.attrs?.gatewayUrl,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "protocol", value: ctx.props?.protocolType },
    ],
  },
);

export const MemoryUI = UIProvider.succeed<Memory>(
  "AWS.BedrockAgentCore.Memory",
  {
    displayName: "AgentCore Memory",
    icon: "brain",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.memoryId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.memoryArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "execution role",
        value: ctx.props?.memoryExecutionRoleArn,
        mono: true,
      },
    ],
  },
);

export const RuntimeUI = UIProvider.succeed<Runtime>(
  "AWS.BedrockAgentCore.Runtime",
  {
    displayName: "AgentCore Runtime",
    icon: "bot",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.agentRuntimeName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.agentRuntimeName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.agentRuntimeId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.agentRuntimeArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.agentRuntimeVersion },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    BrowserCustomUI,
    CodeInterpreterUI,
    GatewayUI,
    MemoryUI,
    RuntimeUI,
  );
