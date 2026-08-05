/**
 * The BOARD — the bot's domain projection over the generic chat
 * summaries (`AI.Chats`): one ReviewBot run per pull request, keyed
 * `owner/repo#N`. GitHub's open-PR list (when available) supplies
 * titles and states for the sidebar.
 */
import type * as AI from "alchemy/AI";

export interface BoardPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "unknown";
  /** The review thread, once the bot has been admitted for this PR. */
  readonly thread: AI.ChatSummary | undefined;
  readonly updatedAt: number;
}

export interface Board {
  /** `owner/repo` — the repository the bot reviews. */
  readonly repo: string;
  readonly prs: Array<BoardPullRequest>;
}

export const buildBoard = (
  repo: string,
  chats: ReadonlyArray<AI.ChatSummary>,
  openPrs:
    | ReadonlyArray<{ readonly number: number; readonly title: string }>
    | undefined,
): Board => {
  const prs = new Map<
    number,
    {
      title: string;
      state: BoardPullRequest["state"];
      thread: AI.ChatSummary | undefined;
      updatedAt: number;
    }
  >();
  const ensure = (number: number) => {
    let pr = prs.get(number);
    if (pr === undefined) {
      pr = { title: `#${number}`, state: "unknown", thread: undefined, updatedAt: 0 };
      prs.set(number, pr);
    }
    return pr;
  };

  for (const open of openPrs ?? []) {
    const pr = ensure(open.number);
    pr.title = open.title;
    pr.state = "open";
  }

  for (const chat of chats) {
    if (chat.term !== "ReviewBot") continue;
    const number = Number(chat.key.match(/#(\d+)$/)?.[1]);
    if (!Number.isFinite(number)) continue;
    const pr = ensure(number);
    pr.thread = chat;
    pr.updatedAt = chat.updatedAt;
    if (pr.state === "unknown" && openPrs !== undefined) {
      pr.state = "closed"; // fetched the open list; not on it
    }
  }

  return {
    repo,
    // newest PR first — activity never reshuffles the sidebar
    prs: [...prs.entries()]
      .map(([number, pr]) => ({ number, ...pr }))
      .sort((a, b) => b.number - a.number),
  };
};
