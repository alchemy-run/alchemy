import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { App } from "./App.ts";
import type { Branch } from "./Branch.ts";

/**
 * Dashboard UI providers for AWS Amplify resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Front-End Web & Mobile (Amplify) brand pink. */
const COLOR = "#E7157B";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const AppUI = UIProvider.succeed<App>("AWS.Amplify.App", {
  displayName: "Amplify App",
  icon: "layers",
  color: COLOR,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) =>
    ctx.attrs?.defaultDomain === undefined
      ? undefined
      : `https://${ctx.attrs.defaultDomain}`,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.appArn);
    return ctx.attrs?.appId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/${ctx.attrs.appId}`;
  },
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.appArn, mono: true, copy: true },
    { label: "platform", value: ctx.attrs?.platform },
    {
      label: "default domain",
      value: ctx.attrs?.defaultDomain,
      mono: true,
      copy: true,
    },
  ],
});

export const BranchUI = UIProvider.succeed<Branch>("AWS.Amplify.Branch", {
  displayName: "Amplify Branch",
  icon: "git-branch",
  color: COLOR,
  category: "compute",
  summary: (ctx) => ctx.attrs?.branchName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.branchArn);
    return ctx.attrs?.appId === undefined ||
      ctx.attrs?.branchName === undefined ||
      region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/${ctx.attrs.appId}/${ctx.attrs.branchName}`;
  },
  facts: (ctx) => [
    { label: "branch", value: ctx.attrs?.branchName, copy: true },
    { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.branchArn, mono: true, copy: true },
  ],
});

export const ui = () => Layer.mergeAll(AppUI, BranchUI);
