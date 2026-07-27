/**
 * The ISSUE BOARD — the org's DOMAIN projection over the generic
 * chat summaries (`AI.Chats`): an `IssueOwner` run keyed `owner/repo#n`
 * anchors issue `n`; kernel parentage (the `admitted` observation's
 * dispatch edge) collects the workers it dispatched, chronological.
 * Roots that anchor no issue (the unlinked-PR desk, Discord) land in
 * `other`. GitHub's open-issues list (when available) supplies
 * titles/state for issues with no channel yet.
 */
import type * as AI from "alchemy/AI";

/** One agent thread on the board. */
export interface BoardThread extends AI.ChatSummary {
  /** Human label — "Engineer", "Reviewer", "PR #59", … */
  readonly label: string;
}

export interface BoardIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "unknown";
  readonly updatedAt: number;
  /** The issue's CHANNEL chat — the thread you open when you click
   *  the issue. Undefined until the owner has been admitted. */
  readonly channel: string | undefined;
  /** Agents the owner dispatched (chronological) — the UI links a
   *  dispatch card in the owner thread to its worker thread through this. */
  readonly agents: Array<BoardThread>;
}

export interface Board {
  readonly issues: Array<BoardIssue>;
  /** Threads that belong to no issue (unlinked PRs, Discord, …). */
  readonly other: Array<BoardThread>;
}

/** Best-effort parse of a chat's first input as a GitHub event. */
const parseEvent = (
  firstInput: string | undefined,
): { issue?: any; pullRequest?: any } => {
  if (firstInput === undefined) return {};
  try {
    const parsed = JSON.parse(firstInput);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

export const buildBoard = (
  chats: ReadonlyArray<AI.ChatSummary>,
  openIssues:
    | ReadonlyArray<{ readonly number: number; readonly title: string }>
    | undefined,
): Board => {
  const byParent = new Map<string, Array<AI.ChatSummary>>();
  for (const chat of chats) {
    if (chat.parent === undefined) continue;
    const siblings = byParent.get(chat.parent) ?? [];
    siblings.push(chat);
    byParent.set(chat.parent, siblings);
  }

  /** Every descendant a root dispatched (the root excluded), flat. */
  const descendants = (chat: AI.ChatSummary): Array<AI.ChatSummary> =>
    (byParent.get(chat.id) ?? []).flatMap((child) => [
      child,
      ...descendants(child),
    ]);

  const label = (chat: AI.ChatSummary): string => {
    if (chat.term === "PullRequestReviewer") {
      return `PR #${chat.key.match(/#(\d+)$/)?.[1] ?? "?"}`;
    }
    return chat.term;
  };

  const issues = new Map<
    number,
    {
      title: string;
      state: BoardIssue["state"];
      channel: string | undefined;
      updatedAt: number;
      agents: Array<AI.ChatSummary>;
    }
  >();
  const ensureIssue = (number: number) => {
    let issue = issues.get(number);
    if (issue === undefined) {
      issue = {
        title: `#${number}`,
        state: "unknown",
        channel: undefined,
        updatedAt: 0,
        agents: [],
      };
      issues.set(number, issue);
    }
    return issue;
  };
  for (const open of openIssues ?? []) {
    const issue = ensureIssue(open.number);
    issue.title = open.title;
    issue.state = "open";
  }

  const other: Array<AI.ChatSummary> = [];
  for (const chat of chats) {
    if (chat.parent !== undefined) continue; // reachable via its root
    const threadNumber = Number(chat.key.match(/#(\d+)$/)?.[1]);
    if (chat.term === "IssueOwner" && Number.isFinite(threadNumber)) {
      const issue = ensureIssue(threadNumber);
      const event = parseEvent(chat.firstInput);
      if (event.issue?.title) issue.title = event.issue.title;
      if (issue.state === "unknown" && openIssues !== undefined) {
        issue.state = "closed"; // fetched the open list; not on it
      }
      issue.channel = chat.id;
      const workers = descendants(chat);
      issue.updatedAt = Math.max(
        chat.updatedAt,
        ...workers.map((worker) => worker.updatedAt),
      );
      issue.agents.push(...workers);
    } else {
      other.push(chat, ...descendants(chat));
    }
  }

  /** Chronological + labeled, with ordinals when a label repeats. */
  const present = (
    threads: Array<AI.ChatSummary>,
  ): Array<BoardThread> => {
    const seen = new Map<string, number>();
    return threads
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((chat) => {
        const base = label(chat);
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return { ...chat, label: count === 1 ? base : `${base} (${count})` };
      });
  };

  const boardIssues = [...issues.entries()]
    .map(([number, issue]) => ({
      number,
      title: issue.title,
      state: issue.state,
      updatedAt: issue.updatedAt,
      channel: issue.channel,
      agents: present(issue.agents),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    issues: boardIssues,
    other: present(other).reverse(),
  };
};
