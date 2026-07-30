import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Blueprint } from "./Blueprint.ts";
import type { DataAutomationLibrary } from "./DataAutomationLibrary.ts";
import type { DataAutomationProject } from "./DataAutomationProject.ts";

/**
 * Dashboard UI providers for AWS BedrockDataAutomation resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS machine learning & AI brand teal. */
const COLOR = "#01A88D";

export const BlueprintUI = UIProvider.succeed<Blueprint>(
  "AWS.BedrockDataAutomation.Blueprint",
  {
    displayName: "Bedrock Data Automation Blueprint",
    icon: "file-text",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.blueprintName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.blueprintName, copy: true },
      { label: "arn", value: ctx.attrs?.blueprintArn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "stage", value: ctx.attrs?.blueprintStage },
    ],
  },
);

export const DataAutomationLibraryUI =
  UIProvider.succeed<DataAutomationLibrary>(
    "AWS.BedrockDataAutomation.DataAutomationLibrary",
    {
      displayName: "Data Automation Library",
      icon: "book-open",
      color: COLOR,
      category: "ai",
      summary: (ctx) => ctx.attrs?.libraryName,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.libraryName, copy: true },
        { label: "arn", value: ctx.attrs?.libraryArn, mono: true, copy: true },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const DataAutomationProjectUI =
  UIProvider.succeed<DataAutomationProject>(
    "AWS.BedrockDataAutomation.DataAutomationProject",
    {
      displayName: "Data Automation Project",
      icon: "sparkles",
      color: COLOR,
      category: "ai",
      summary: (ctx) => ctx.attrs?.projectName,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.projectName, copy: true },
        { label: "arn", value: ctx.attrs?.projectArn, mono: true, copy: true },
        { label: "stage", value: ctx.attrs?.projectStage },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(BlueprintUI, DataAutomationLibraryUI, DataAutomationProjectUI);
