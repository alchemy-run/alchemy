import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { BranchProtection } from "./BranchProtection.ts";
import type { Collaborator } from "./Collaborator.ts";
import type { Environment } from "./Environment.ts";
import type { Comment } from "./Comment.ts";
import type { Issue } from "./Issue.ts";
import type { Label } from "./Label.ts";
import type { Milestone } from "./Milestone.ts";
import type { PullRequest } from "./PullRequest.ts";
import type { Release } from "./Release.ts";
import type { Repository } from "./Repository.ts";
import type { Ruleset } from "./Ruleset.ts";
import type { Secret } from "./Secret.ts";
import type { TeamAccess } from "./TeamAccess.ts";
import type { Variable } from "./Variable.ts";
import type { Webhook } from "./Webhook.ts";
import type { WikiPage } from "./WikiPage.ts";

/**
 * Dashboard UI providers for GitHub resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no GitHub SDK code reaches the dashboard bundle.
 */

const GITHUB = "#9198a1";

/** `owner/repository` from persisted props, or undefined until deployed. */
const repoOf = (ctx: { props?: Record<string, any> }) =>
  ctx.props?.owner && ctx.props?.repository
    ? `${ctx.props.owner}/${ctx.props.repository}`
    : undefined;

/** GitHub web URL for a path under the repo, when owner/repo are known. */
const repoUrl = (ctx: { props?: Record<string, any> }, path: string) =>
  ctx.props?.owner && ctx.props?.repository
    ? `https://github.com/${ctx.props.owner}/${ctx.props.repository}${path}`
    : undefined;

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

export const BranchProtectionUI = UIProvider.succeed<BranchProtection>(
  "GitHub.BranchProtection",
  {
    displayName: "GitHub Branch Protection",
    icon: "shield",
    color: GITHUB,
    category: "security",
    summary: (ctx) => ctx.attrs?.branch ?? ctx.props?.branch,
    consoleUrl: (ctx) => repoUrl(ctx, "/settings/branches"),
    facts: (ctx) => [
      { label: "branch", value: ctx.attrs?.branch, mono: true, copy: true },
      { label: "repository", value: repoOf(ctx) },
      { label: "enforce admins", value: ctx.attrs?.enforceAdmins },
      { label: "required signatures", value: ctx.attrs?.requiredSignatures },
      {
        label: "required linear history",
        value: ctx.attrs?.requiredLinearHistory,
      },
      { label: "allow force pushes", value: ctx.attrs?.allowForcePushes },
      { label: "lock branch", value: ctx.attrs?.lockBranch },
    ],
  },
);

export const CollaboratorUI = UIProvider.succeed<Collaborator>(
  "GitHub.Collaborator",
  {
    displayName: "GitHub Collaborator",
    icon: "user-plus",
    color: GITHUB,
    category: "auth",
    summary: (ctx) => ctx.attrs?.username ?? ctx.props?.username,
    consoleUrl: (ctx) => repoUrl(ctx, "/settings/access"),
    facts: (ctx) => {
      const profile = ctx.attrs?.username
        ? `https://github.com/${ctx.attrs.username}`
        : undefined;
      return [
        { label: "username", value: ctx.attrs?.username, copy: true },
        { label: "permission", value: ctx.attrs?.permission },
        { label: "repository", value: repoOf(ctx) },
        { label: "profile", value: profile, href: profile },
      ];
    },
  },
);

export const IssueUI = UIProvider.succeed<Issue>("GitHub.Issue", {
  displayName: "GitHub Issue",
  icon: "circle-dot",
  color: GITHUB,
  category: "other",
  summary: (ctx) =>
    ctx.attrs?.issueNumber !== undefined && ctx.props?.title
      ? `#${ctx.attrs.issueNumber} ${ctx.props.title}`
      : ctx.props?.title,
  link: (ctx) => ctx.attrs?.htmlUrl,
  consoleUrl: (ctx) =>
    ctx.attrs?.htmlUrl ??
    (ctx.attrs?.issueNumber !== undefined
      ? repoUrl(ctx, `/issues/${ctx.attrs.issueNumber}`)
      : undefined),
  facts: (ctx) => [
    { label: "number", value: ctx.attrs?.issueNumber, mono: true },
    { label: "title", value: ctx.props?.title, copy: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "repository", value: repoOf(ctx) },
    {
      label: "labels",
      value: Array.isArray(ctx.props?.labels)
        ? ctx.props.labels.join(", ")
        : undefined,
    },
    { label: "url", value: ctx.attrs?.htmlUrl, href: ctx.attrs?.htmlUrl },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const LabelUI = UIProvider.succeed<Label>("GitHub.Label", {
  displayName: "GitHub Label",
  icon: "tag",
  color: GITHUB,
  category: "config",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  consoleUrl: (ctx) => repoUrl(ctx, "/labels"),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "color", value: ctx.attrs?.color, mono: true, copy: true },
    { label: "description", value: ctx.attrs?.description ?? undefined },
    { label: "repository", value: repoOf(ctx) },
    { label: "label id", value: ctx.attrs?.labelId, mono: true, copy: true },
    { label: "default", value: ctx.attrs?.default },
    {
      label: "api url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      mono: true,
    },
  ],
});

export const MilestoneUI = UIProvider.succeed<Milestone>("GitHub.Milestone", {
  displayName: "GitHub Milestone",
  icon: "milestone",
  color: GITHUB,
  category: "other",
  summary: (ctx) => ctx.attrs?.title ?? ctx.props?.title,
  link: (ctx) => ctx.attrs?.htmlUrl,
  consoleUrl: (ctx) =>
    ctx.attrs?.htmlUrl ??
    (ctx.attrs?.milestoneNumber !== undefined
      ? repoUrl(ctx, `/milestone/${ctx.attrs.milestoneNumber}`)
      : undefined),
  facts: (ctx) => [
    { label: "number", value: ctx.attrs?.milestoneNumber, mono: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "repository", value: repoOf(ctx) },
    { label: "due on", value: ctx.attrs?.dueOn ?? undefined },
    { label: "open issues", value: ctx.attrs?.openIssues },
    { label: "closed issues", value: ctx.attrs?.closedIssues },
    { label: "url", value: ctx.attrs?.htmlUrl, href: ctx.attrs?.htmlUrl },
  ],
});

export const PullRequestUI = UIProvider.succeed<PullRequest>(
  "GitHub.PullRequest",
  {
    displayName: "GitHub Pull Request",
    icon: "git-pull-request",
    color: GITHUB,
    category: "other",
    summary: (ctx) =>
      ctx.attrs?.prNumber !== undefined && ctx.props?.title
        ? `#${ctx.attrs.prNumber} ${ctx.props.title}`
        : ctx.props?.title,
    link: (ctx) => ctx.attrs?.htmlUrl,
    consoleUrl: (ctx) =>
      ctx.attrs?.htmlUrl ??
      (ctx.attrs?.prNumber !== undefined
        ? repoUrl(ctx, `/pull/${ctx.attrs.prNumber}`)
        : undefined),
    facts: (ctx) => [
      { label: "number", value: ctx.attrs?.prNumber, mono: true },
      { label: "state", value: ctx.attrs?.state },
      { label: "merged", value: ctx.attrs?.merged },
      { label: "draft", value: ctx.attrs?.draft },
      {
        label: "branches",
        value:
          ctx.props?.head && ctx.props?.base
            ? `${ctx.props.head} -> ${ctx.props.base}`
            : undefined,
        mono: true,
      },
      { label: "repository", value: repoOf(ctx) },
      { label: "url", value: ctx.attrs?.htmlUrl, href: ctx.attrs?.htmlUrl },
    ],
  },
);

export const ReleaseUI = UIProvider.succeed<Release>("GitHub.Release", {
  displayName: "GitHub Release",
  icon: "rocket",
  color: GITHUB,
  category: "other",
  summary: (ctx) => ctx.attrs?.tagName ?? ctx.props?.tagName,
  link: (ctx) => ctx.attrs?.htmlUrl,
  consoleUrl: (ctx) =>
    ctx.attrs?.htmlUrl ??
    (ctx.attrs?.tagName
      ? repoUrl(ctx, `/releases/tag/${ctx.attrs.tagName}`)
      : undefined),
  facts: (ctx) => [
    { label: "tag", value: ctx.attrs?.tagName, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "repository", value: repoOf(ctx) },
    { label: "draft", value: ctx.attrs?.draft },
    { label: "prerelease", value: ctx.attrs?.prerelease },
    { label: "published", value: ctx.attrs?.publishedAt ?? undefined },
    { label: "url", value: ctx.attrs?.htmlUrl, href: ctx.attrs?.htmlUrl },
  ],
});

export const RulesetUI = UIProvider.succeed<Ruleset>("GitHub.Ruleset", {
  displayName: "GitHub Ruleset",
  icon: "shield-check",
  color: GITHUB,
  category: "security",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  consoleUrl: (ctx) =>
    ctx.attrs?.rulesetId !== undefined
      ? repoUrl(ctx, `/settings/rules/${ctx.attrs.rulesetId}`)
      : repoUrl(ctx, "/settings/rules"),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "ruleset id",
      value: ctx.attrs?.rulesetId,
      mono: true,
      copy: true,
    },
    { label: "repository", value: repoOf(ctx) },
    { label: "target", value: ctx.props?.target },
    { label: "enforcement", value: ctx.props?.enforcement },
    { label: "node id", value: ctx.attrs?.nodeId, mono: true },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const TeamAccessUI = UIProvider.succeed<TeamAccess>(
  "GitHub.TeamAccess",
  {
    displayName: "GitHub Team Access",
    icon: "users",
    color: GITHUB,
    category: "auth",
    summary: (ctx) => ctx.attrs?.teamSlug ?? ctx.props?.teamSlug,
    consoleUrl: (ctx) => repoUrl(ctx, "/settings/access"),
    facts: (ctx) => {
      const team =
        ctx.props?.owner && ctx.attrs?.teamSlug
          ? `https://github.com/orgs/${ctx.props.owner}/teams/${ctx.attrs.teamSlug}`
          : undefined;
      return [
        { label: "team", value: ctx.attrs?.teamSlug, mono: true, copy: true },
        { label: "permission", value: ctx.attrs?.permission },
        { label: "repository", value: repoOf(ctx) },
        { label: "team url", value: team, href: team },
      ];
    },
  },
);

export const WikiPageUI = UIProvider.succeed<WikiPage>("GitHub.WikiPage", {
  displayName: "GitHub Wiki Page",
  icon: "book-open",
  color: GITHUB,
  category: "other",
  summary: (ctx) => ctx.attrs?.title ?? ctx.props?.title,
  link: (ctx) => ctx.attrs?.htmlUrl,
  consoleUrl: (ctx) =>
    ctx.attrs?.htmlUrl ??
    (ctx.attrs?.pageName
      ? repoUrl(ctx, `/wiki/${ctx.attrs.pageName}`)
      : undefined),
  facts: (ctx) => [
    { label: "title", value: ctx.attrs?.title, copy: true },
    { label: "page", value: ctx.attrs?.pageName, mono: true, copy: true },
    { label: "repository", value: repoOf(ctx) },
    { label: "format", value: ctx.props?.format },
    { label: "sha", value: ctx.attrs?.sha, mono: true, copy: true },
    { label: "url", value: ctx.attrs?.htmlUrl, href: ctx.attrs?.htmlUrl },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    RepositoryUI,
    SecretUI,
    VariableUI,
    WebhookUI,
    CommentUI,
    EnvironmentUI,
    BranchProtectionUI,
    CollaboratorUI,
    IssueUI,
    LabelUI,
    MilestoneUI,
    PullRequestUI,
    ReleaseUI,
    RulesetUI,
    TeamAccessUI,
    WikiPageUI,
  );
