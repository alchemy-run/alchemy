import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Domain } from "./Domain.ts";
import type { Environment } from "./Environment.ts";
import type { EnvironmentBlueprintConfiguration } from "./EnvironmentBlueprintConfiguration.ts";
import type { Project } from "./Project.ts";

/**
 * Dashboard UI providers for AWS DataZone resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS analytics brand purple (DataZone). */
const COLOR = "#8C4FFF";

export const DomainUI = UIProvider.succeed<Domain>("AWS.DataZone.Domain", {
  displayName: "DataZone Domain",
  icon: "building-2",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) => ctx.attrs?.portalUrl,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.domainId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.domainArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "portal",
      value: ctx.attrs?.portalUrl,
      href: ctx.attrs?.portalUrl,
      copy: true,
    },
    {
      label: "execution role",
      value: ctx.attrs?.domainExecutionRole,
      mono: true,
    },
  ],
});

export const EnvironmentUI = UIProvider.succeed<Environment>(
  "AWS.DataZone.Environment",
  {
    displayName: "DataZone Environment",
    icon: "server",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.environmentId, mono: true, copy: true },
      { label: "domain", value: ctx.attrs?.domainId, mono: true },
      { label: "project", value: ctx.attrs?.projectId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "aws account", value: ctx.attrs?.awsAccountId, mono: true },
      { label: "region", value: ctx.attrs?.awsAccountRegion },
    ],
  },
);

export const EnvironmentBlueprintConfigurationUI =
  UIProvider.succeed<EnvironmentBlueprintConfiguration>(
    "AWS.DataZone.EnvironmentBlueprintConfiguration",
    {
      displayName: "Environment Blueprint Configuration",
      icon: "settings",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.environmentBlueprintName,
      facts: (ctx) => [
        {
          label: "blueprint",
          value: ctx.attrs?.environmentBlueprintName,
          copy: true,
        },
        { label: "domain", value: ctx.attrs?.domainId, mono: true },
        {
          label: "blueprint id",
          value: ctx.attrs?.environmentBlueprintId,
          mono: true,
        },
        {
          label: "enabled regions",
          value: ctx.attrs?.enabledRegions?.join(", "),
        },
        {
          label: "provisioning role",
          value: ctx.attrs?.provisioningRoleArn,
          mono: true,
        },
      ],
    },
  );

export const ProjectUI = UIProvider.succeed<Project>("AWS.DataZone.Project", {
  displayName: "DataZone Project",
  icon: "folder",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.projectId, mono: true, copy: true },
    { label: "domain", value: ctx.attrs?.domainId, mono: true },
    { label: "status", value: ctx.attrs?.projectStatus },
    { label: "created by", value: ctx.attrs?.createdBy, mono: true },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    DomainUI,
    EnvironmentUI,
    EnvironmentBlueprintConfigurationUI,
    ProjectUI,
  );
