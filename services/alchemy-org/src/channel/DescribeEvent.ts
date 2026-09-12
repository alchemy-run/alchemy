import * as GitHub from "alchemy/GitHub";
import type { AppendInput, ChannelAuthor } from "./Channel.ts";

/** One line of a possibly-long body, trimmed to fit a channel row. */
const firstLine = (body: string | null | undefined, max = 140): string => {
  const line = (body ?? "").split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const link = (repo: string, number: number, url: string | undefined): string =>
  url === undefined ? `${repo}#${number}` : `[#${number}](${url})`;

/**
 * Render one GitHub delivery as the channel's event row. Pure — the
 * ChannelDO appends what this returns; tests read it directly. The
 * author is the delivery's `sender` (who ACTED), falling back to the
 * subject's own author for REST-synthesized events that carry none.
 */
export const describeEvent = (event: GitHub.RepositoryEvent): AppendInput => {
  const repo = `${event.repository.owner.login}/${event.repository.name}`;
  const ref = GitHub.eventKey(event);
  const base = { kind: "event" as const, repo, ref, event: event._tag };
  const author = (
    fallback?: { login: string } | null,
  ): ChannelAuthor | undefined =>
    event._tag === "Push" ? undefined : (event.sender ?? fallback ?? undefined);

  switch (event._tag) {
    case "IssueOpened":
      return {
        ...base,
        author: author(event.issue.user),
        text: `opened issue ${link(repo, event.issue.number, event.issue.html_url)} — ${event.issue.title}`,
      };
    case "IssueLabeled":
      return {
        ...base,
        author: author(),
        text: `labeled ${link(repo, event.issue.number, event.issue.html_url)} \`${event.label.name}\``,
      };
    case "IssueClosed":
      return {
        ...base,
        author: author(),
        text: `closed issue ${link(repo, event.issue.number, event.issue.html_url)} — ${event.issue.title}`,
      };
    case "IssueCommented": {
      const kind = GitHub.isPullRequestComment(event)
        ? "pull request"
        : "issue";
      return {
        ...base,
        author: author(event.comment.user),
        text: `commented on ${kind} ${link(repo, event.issue.number, event.comment.html_url ?? event.issue.html_url)}: ${firstLine(event.comment.body)}`,
      };
    }
    case "PullRequestOpened":
      return {
        ...base,
        author: author(event.pullRequest.user),
        text: `opened pull request ${link(repo, event.pullRequest.number, event.pullRequest.html_url)} — ${event.pullRequest.title}`,
      };
    case "PullRequestSynchronized":
      return {
        ...base,
        author: author(event.pullRequest.user),
        text: `pushed to pull request ${link(repo, event.pullRequest.number, event.pullRequest.html_url)} — ${event.pullRequest.title}`,
      };
    case "PullRequestMerged":
      return {
        ...base,
        author: author(),
        text: `merged pull request ${link(repo, event.pullRequest.number, event.pullRequest.html_url)} — ${event.pullRequest.title}`,
      };
    case "PullRequestClosed":
      return {
        ...base,
        author: author(),
        text: `closed pull request ${link(repo, event.pullRequest.number, event.pullRequest.html_url)} without merging`,
      };
    case "Push": {
      // the head commit as a link — the UI's commit hover card keys on
      // the `/commit/<sha>` URL shape, like it keys `/pull/N` for refs
      const head = event.headCommit;
      const sha =
        head === null
          ? ""
          : ` [\`${head.id.slice(0, 7)}\`](https://github.com/${repo}/commit/${head.id})`;
      return {
        ...base,
        text: `pushed${sha} to \`${event.branch}\`${
          head === null ? "" : ` — ${firstLine(head.message)}`
        }`,
      };
    }
  }
};
