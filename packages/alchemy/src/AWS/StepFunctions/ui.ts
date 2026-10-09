import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Activity } from "./Activity.ts";
import type { StateMachine } from "./StateMachine.ts";

/**
 * Dashboard UI providers for AWS Step Functions resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#E7157B";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ActivityUI = UIProvider.succeed<Activity>(
  "AWS.StepFunctions.Activity",
  {
    displayName: "Step Functions Activity",
    icon: "inbox",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.activityName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.activityArn);
      return ctx.attrs?.activityArn === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/states/home?region=${region}#/activities/details/${encodeURIComponent(ctx.attrs.activityArn)}`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.activityName, copy: true },
      { label: "arn", value: ctx.attrs?.activityArn, mono: true, copy: true },
    ],
  },
);

export const StateMachineUI = UIProvider.succeed<StateMachine>(
  "AWS.StepFunctions.StateMachine",
  {
    displayName: "Step Functions State Machine",
    icon: "workflow",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.stateMachineName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.stateMachineArn);
      return ctx.attrs?.stateMachineArn === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines/view/${encodeURIComponent(ctx.attrs.stateMachineArn)}`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.stateMachineName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.stateMachineArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(ActivityUI, StateMachineUI);
