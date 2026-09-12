import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Environment } from "./Environment.ts";
import type { Comment } from "./Comment.ts";
import type { Repository } from "./Repository.ts";
import type { Secret } from "./Secret.ts";
import type { Variable } from "./Variable.ts";
import type { Webhook } from "./Webhook.ts";

/**
 * Dashboard UI providers for GitHub resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no GitHub SDK code reaches the dashboard bundle.
 */

const GITHUB = "#9198a1";

export const RepositoryUI = UIProvider.succeed<Repository>(
  "GitHub.Repository",
  {
    displayName: "GitHub Repository",
    icon: "folder-git-2",
    color: GITHUB,
    category: "other",
    summary: (ctx) =>
      ctx.attrs?.fullName ??
      (ctx.props?.owner && ctx.props?.name
        ? `${ctx.props.owner}/${ctx.props.name}`
        : undefined),
    link: (ctx) => ctx.attrs?.htmlUrl,
    consoleUrl: (ctx) => ctx.attrs?.htmlUrl,
    facts: (ctx) => [
      { label: "full name", value: ctx.attrs?.fullName, copy: true },
      { label: "repo id", value: ctx.attrs?.repoId, mono: true, copy: true },
      { label: "visibility", value: ctx.props?.visibility },
      { label: "default branch", value: ctx.attrs?.defaultBranch },
      {
        label: "clone (https)",
        value: ctx.attrs?.cloneUrl,
        mono: true,
        copy: true,
      },
      {
        label: "clone (ssh)",
        value: ctx.attrs?.sshUrl,
        mono: true,
        copy: true,
      },
      {
        label: "url",
        value: ctx.attrs?.htmlUrl,
        href: ctx.attrs?.htmlUrl,
      },
    ],
  },
);

export const SecretUI = UIProvider.succeed<Secret>("GitHub.Secret", {
  displayName: "GitHub Actions Secret",
  icon: "key-round",
  color: GITHUB,
  category: "security",
  summary: (ctx) => ctx.props?.name,
  consoleUrl: (ctx) =>
    ctx.props?.owner && ctx.props?.repository
      ? `https://github.com/${ctx.props.owner}/${ctx.props.repository}/settings/secrets/actions`
      : undefined,
  facts: (ctx) => [
    { label: "name", value: ctx.props?.name, mono: true, copy: true },
    {
      label: "repository",
      value:
        ctx.props?.owner && ctx.props?.repository
          ? `${ctx.props.owner}/${ctx.props.repository}`
          : undefined,
    },
    { label: "environment", value: ctx.props?.environment },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const VariableUI = UIProvider.succeed<Variable>("GitHub.Variable", {
  displayName: "GitHub Actions Variable",
  icon: "variable",
  color: GITHUB,
  category: "config",
  summary: (ctx) => ctx.props?.name,
  consoleUrl: (ctx) =>
    ctx.props?.owner && ctx.props?.repository
      ? `https://github.com/${ctx.props.owner}/${ctx.props.repository}/settings/variables/actions`
      : undefined,
  facts: (ctx) => [
    { label: "name", value: ctx.props?.name, mono: true, copy: true },
    { label: "value", value: ctx.props?.value, mono: true, copy: true },
    {
      label: "repository",
      value:
        ctx.props?.owner && ctx.props?.repository
          ? `${ctx.props.owner}/${ctx.props.repository}`
          : undefined,
    },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const WebhookUI = UIProvider.succeed<Webhook>("GitHub.Webhook", {
  displayName: "GitHub Webhook",
  icon: "webhook",
  color: GITHUB,
  category: "eventing",
  summary: (ctx) => ctx.attrs?.url,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) =>
    ctx.props?.owner &&
    ctx.props?.repository &&
    ctx.attrs?.webhookId !== undefined
      ? `https://github.com/${ctx.props.owner}/${ctx.props.repository}/settings/hooks/${ctx.attrs.webhookId}`
      : undefined,
  facts: (ctx) => [
    {
      label: "webhook id",
      value: ctx.attrs?.webhookId,
      mono: true,
      copy: true,
    },
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
    {
      label: "repository",
      value:
        ctx.props?.owner && ctx.props?.repository
          ? `${ctx.props.owner}/${ctx.props.repository}`
          : undefined,
    },
    {
      label: "events",
      value: Array.isArray(ctx.props?.events)
        ? ctx.props.events.join(", ")
        : undefined,
    },
    { label: "active", value: ctx.props?.active },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const CommentUI = UIProvider.succeed<Comment>("GitHub.Comment", {
  displayName: "GitHub Comment",
  icon: "message-square",
  color: GITHUB,
  category: "other",
  summary: (ctx) =>
    ctx.props?.owner && ctx.props?.repository && ctx.props?.issueNumber
      ? `${ctx.props.owner}/${ctx.props.repository}#${ctx.props.issueNumber}`
      : undefined,
  link: (ctx) => ctx.attrs?.htmlUrl,
  consoleUrl: (ctx) => ctx.attrs?.htmlUrl,
  facts: (ctx) => [
    {
      label: "comment id",
      value: ctx.attrs?.commentId,
      mono: true,
      copy: true,
    },
    {
      label: "issue",
      value:
        ctx.props?.owner && ctx.props?.repository && ctx.props?.issueNumber
          ? `${ctx.props.owner}/${ctx.props.repository}#${ctx.props.issueNumber}`
          : undefined,
    },
    {
      label: "url",
      value: ctx.attrs?.htmlUrl,
      href: ctx.attrs?.htmlUrl,
    },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const EnvironmentUI = UIProvider.succeed<Environment>(
  "GitHub.Environment",
  {
    displayName: "GitHub Environment",
    icon: "shield-check",
    color: GITHUB,
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.htmlUrl,
    facts: (ctx) => [
      { label: "environment", value: ctx.attrs?.name, copy: true },
      { label: "repository", value: ctx.props?.repository, mono: true },
      { label: "owner", value: ctx.props?.owner, mono: true },
      { label: "id", value: ctx.attrs?.environmentId, mono: true },
      {
        label: "url",
        value: ctx.attrs?.htmlUrl,
        href: ctx.attrs?.htmlUrl,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    RepositoryUI,
    SecretUI,
    VariableUI,
    WebhookUI,
    CommentUI,
    EnvironmentUI,
  );
