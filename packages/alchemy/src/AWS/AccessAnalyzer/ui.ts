import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Analyzer } from "./Analyzer.ts";
import type { ArchiveRule } from "./ArchiveRule.ts";

/**
 * Dashboard UI providers for AWS AccessAnalyzer resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const AnalyzerUI = UIProvider.succeed<Analyzer>(
  "AWS.AccessAnalyzer.Analyzer",
  {
    displayName: "Access Analyzer",
    icon: "search",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.analyzerName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.analyzerArn);
      return ctx.attrs?.analyzerName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/access-analyzer/home?region=${region}#/analyzer/${encodeURIComponent(ctx.attrs.analyzerName)}`;
    },
    facts: (ctx) => [
      { label: "analyzer", value: ctx.attrs?.analyzerName, copy: true },
      { label: "arn", value: ctx.attrs?.analyzerArn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ArchiveRuleUI = UIProvider.succeed<ArchiveRule>(
  "AWS.AccessAnalyzer.ArchiveRule",
  {
    displayName: "Analyzer Archive Rule",
    icon: "archive",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.ruleName,
    facts: (ctx) => [
      { label: "rule", value: ctx.attrs?.ruleName, copy: true },
      { label: "analyzer", value: ctx.attrs?.analyzerName, copy: true },
      {
        label: "filtered attributes",
        value: ctx.props?.filter
          ? Object.keys(ctx.props.filter).length
          : undefined,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(AnalyzerUI, ArchiveRuleUI);
