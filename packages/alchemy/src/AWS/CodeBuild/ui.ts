import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Project } from "./Project.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Dashboard UI providers for AWS CodeBuild resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Compute (CodeBuild) brand orange. */
const COLOR = "#ED7100";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ProjectUI = UIProvider.succeed<Project>("AWS.CodeBuild.Project", {
  displayName: "CodeBuild Project",
  icon: "wrench",
  color: COLOR,
  category: "compute",
  summary: (ctx) => ctx.attrs?.projectName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.projectArn);
    return ctx.attrs?.projectName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${ctx.attrs.projectName}`;
  },
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.projectName, copy: true },
    { label: "arn", value: ctx.attrs?.projectArn, mono: true, copy: true },
  ],
});

export const ReportGroupUI = UIProvider.succeed<ReportGroup>(
  "AWS.CodeBuild.ReportGroup",
  {
    displayName: "CodeBuild Report Group",
    icon: "table",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.reportGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.reportGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.reportGroupArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(ProjectUI, ReportGroupUI);
