import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Dataset } from "./Dataset.ts";
import type { Job } from "./Job.ts";
import type { Project } from "./Project.ts";
import type { Recipe } from "./Recipe.ts";
import type { Ruleset } from "./Ruleset.ts";
import type { Schedule } from "./Schedule.ts";

/**
 * Dashboard UI providers for AWS DataBrew resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics (DataBrew) brand purple. */
const COLOR = "#8C4FFF";

export const DatasetUI = UIProvider.succeed<Dataset>("AWS.DataBrew.Dataset", {
  displayName: "DataBrew Dataset",
  icon: "table",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.datasetName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.datasetName, copy: true },
    { label: "arn", value: ctx.attrs?.datasetArn, mono: true, copy: true },
    { label: "format", value: ctx.props?.format },
    {
      label: "bucket",
      value: ctx.props?.input?.s3InputDefinition?.bucket,
      mono: true,
    },
  ],
});

export const JobUI = UIProvider.succeed<Job>("AWS.DataBrew.Job", {
  displayName: "DataBrew Job",
  icon: "play",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.jobName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.jobName, copy: true },
    { label: "arn", value: ctx.attrs?.jobArn, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "dataset", value: ctx.props?.datasetName, mono: true },
    { label: "role", value: ctx.props?.role, mono: true },
  ],
});

export const ProjectUI = UIProvider.succeed<Project>("AWS.DataBrew.Project", {
  displayName: "DataBrew Project",
  icon: "pencil-ruler",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.projectName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.projectName, copy: true },
    { label: "arn", value: ctx.attrs?.projectArn, mono: true, copy: true },
    { label: "dataset", value: ctx.props?.datasetName, mono: true },
    { label: "recipe", value: ctx.props?.recipeName, mono: true },
  ],
});

export const RecipeUI = UIProvider.succeed<Recipe>("AWS.DataBrew.Recipe", {
  displayName: "DataBrew Recipe",
  icon: "book-open",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.recipeName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.recipeName, copy: true },
    { label: "arn", value: ctx.attrs?.recipeArn, mono: true, copy: true },
    { label: "version", value: ctx.attrs?.recipeVersion, mono: true },
    { label: "steps", value: ctx.props?.steps?.length },
    { label: "published", value: ctx.props?.publish },
  ],
});

export const RulesetUI = UIProvider.succeed<Ruleset>("AWS.DataBrew.Ruleset", {
  displayName: "DataBrew Ruleset",
  icon: "test-tube",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.rulesetName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.rulesetName, copy: true },
    { label: "arn", value: ctx.attrs?.rulesetArn, mono: true, copy: true },
    { label: "target", value: ctx.attrs?.targetArn, mono: true, copy: true },
    { label: "rules", value: ctx.props?.rules?.length },
  ],
});

export const ScheduleUI = UIProvider.succeed<Schedule>(
  "AWS.DataBrew.Schedule",
  {
    displayName: "DataBrew Schedule",
    icon: "calendar",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.scheduleName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.scheduleName, copy: true },
      { label: "arn", value: ctx.attrs?.scheduleArn, mono: true, copy: true },
      { label: "cron", value: ctx.props?.cronExpression, mono: true },
      { label: "jobs", value: ctx.props?.jobNames?.join(", ") },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(DatasetUI, JobUI, ProjectUI, RecipeUI, RulesetUI, ScheduleUI);
