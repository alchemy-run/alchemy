/**
 * GitHub EventSources for the organization.
 *
 * An EventSource is the world-side topic (GitHub emits `issues.opened`
 * events shaped like this schema); loops subscribe to it with `AI.on(...)`
 * (the loop-side trigger). One source can wake many rings.
 *
 * These constructors are the AI-term analogue of
 * `GitHub.consumeRepositoryEvents` (src/GitHub/RepositoryEventSource.ts):
 * at deploy time an EventSource compiles to webhook-ingestion
 * infrastructure, while each `AI.on` compiles to routing from that webhook
 * to the subscribing ring. The schemas here are the distilled work-item
 * shapes the org's agents consume, not the full Octokit payloads.
 */
import * as Context from "effect/Context";
import * as S from "effect/Schema";
import * as AI from "@/AI/index.ts";
import type { GitHubEventName, RepositoryRef } from "@/GitHub/index.ts";

/**
 * The channel tag for the GitHub event family: the service a harness must
 * provide to deliver these sources. `AI.on(Github.IssueOpened(repo))` in a
 * charter places this tag in the loop's `Req` — declaring the subscription
 * is what obligates the deployment to provision the delivery wire (on
 * Cloudflare: a repository webhook pointing at the Worker, provisioned by
 * `GitHub.RepositoryEventSource` + `GitHubRepositoryEventSourceLive`,
 * driven by the union of subscribed sources' props — never a side list).
 */
export class GitHubEvents extends Context.Service<
  GitHubEvents,
  AI.EventChannelService
>()("org/GitHubEvents") {}

/**
 * Pure definition data carried by every GitHub source (the binding idiom:
 * props tell the channel Layer what to provision and what to filter;
 * behavior lives exclusively in the Layer).
 */
export interface GitHubSourceProps {
  repo: RepositoryRef;
  /** Bare GitHub event name — what the webhook is provisioned with. */
  event: GitHubEventName;
  /** Family-specific runtime filter (action, label, branch, …). */
  filter?: Record<string, string | undefined>;
}

export const IssueOpenedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  title: S.String,
  body: S.String,
});

export const IssueLabeledEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  label: S.String,
});

export const PullRequestOpenedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  title: S.String,
});

export const PushEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  branch: S.String,
  title: S.String,
});

const key = (repo: RepositoryRef) => `${repo.owner}/${repo.repository}`;

export const IssueOpened = (repo: RepositoryRef) =>
  AI.EventSource(
    `github.issues.opened/${key(repo)}`,
    IssueOpenedEvent,
    GitHubEvents,
    {
      repo,
      event: "issues",
      filter: { action: "opened" },
    } satisfies GitHubSourceProps,
  );

export const IssueLabeled = (repo: RepositoryRef, label: string) =>
  AI.EventSource(
    `github.issues.labeled/${key(repo)}#${label}`,
    IssueLabeledEvent,
    GitHubEvents,
    {
      repo,
      event: "issues",
      filter: { action: "labeled", label },
    } satisfies GitHubSourceProps,
  );

export const PullRequestOpened = (repo: RepositoryRef) =>
  AI.EventSource(
    `github.pull_request.opened/${key(repo)}`,
    PullRequestOpenedEvent,
    GitHubEvents,
    {
      repo,
      event: "pull_request",
      filter: { action: "opened" },
    } satisfies GitHubSourceProps,
  );

export const Push = (
  repo: RepositoryRef,
  filter: { branch: string; titlePrefix?: string },
) =>
  AI.EventSource(
    `github.push/${key(repo)}@${filter.branch}`,
    PushEvent,
    GitHubEvents,
    { repo, event: "push", filter: { ...filter } } satisfies GitHubSourceProps,
  );
