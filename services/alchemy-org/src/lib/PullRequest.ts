import type * as GitHub from "alchemy/GitHub";

/**
 * The PULL REQUEST as a session subject. A PR's session key is
 * `owner/repo#N` — the ReviewBot's session (`ReviewBot:owner/repo#N`),
 * the operator's engineer threads (`Engineer:owner/repo#N` and
 * `Engineer:owner/repo#N::<thread>`), and their terminals all share
 * the ONE machine that key names (`SandboxSession`'s `machineKey`
 * strips the `::<thread>` suffix), and that machine's tree is the PR's
 * head.
 */
export const pullSessionKey = (repo: string, number: number): string =>
  `${repo}#${number}`;

/** `owner/repo#N` → its parts; `undefined` for any other key shape. */
export const parsePullKey = (
  key: string,
): { readonly repo: string; readonly number: number } | undefined => {
  const match = key.match(/^([^#\s:]+\/[^#\s:/]+)#(\d+)$/);
  return match === null
    ? undefined
    : { repo: match[1]!, number: Number(match[2]) };
};

/**
 * The ref a PR session checks out. GitHub serves every PR's tip at
 * `pull/N/head` (fork PRs included) — read-only, since nothing pushes
 * there. When the head lives in the SAME repository the head BRANCH
 * itself is the better tree: a `checkout -B <branch> origin/<branch>`
 * lands on the real branch, so `pushBranch` back onto it carries fixes
 * straight into the PR.
 */
export const pullRequestRef = (pull: {
  readonly number: number;
  readonly head: {
    readonly ref: string;
    readonly repo: { readonly full_name: string } | null;
  };
  readonly base: { readonly repo: { readonly full_name: string } };
}): string =>
  pull.head.repo !== null &&
  pull.head.repo.full_name === pull.base.repo.full_name
    ? pull.head.ref
    : `pull/${pull.number}/head`;

/* ── the review page's projection ─────────────────────────────── */

export interface PullRequestAuthor {
  readonly login: string;
  readonly avatarUrl: string;
}

/** One row of the PR's conversation, GitHub-timeline style. */
export type PullRequestTimelineItem =
  | {
      readonly kind: "comment";
      readonly id: number;
      readonly author: PullRequestAuthor;
      readonly body: string;
      readonly createdAt: string;
      readonly htmlUrl: string;
    }
  | {
      readonly kind: "review";
      readonly id: number;
      readonly author: PullRequestAuthor;
      readonly state: string;
      readonly body: string;
      readonly createdAt: string;
      readonly htmlUrl: string;
      /** The review's inline comments, in file order. */
      readonly comments: ReadonlyArray<PullRequestInlineComment>;
    };

export interface PullRequestInlineComment {
  readonly id: number;
  readonly author: PullRequestAuthor;
  readonly path: string;
  readonly line: number | undefined;
  readonly startLine: number | undefined;
  readonly body: string;
  readonly diffHunk: string;
  readonly createdAt: string;
  readonly htmlUrl: string;
  /** Set on a reply — the id of the inline comment it answers. */
  readonly inReplyTo: number | undefined;
}

export interface PullRequestView {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed" | "merged" | "draft";
  readonly author: PullRequestAuthor;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: string | undefined };
  readonly base: { readonly ref: string; readonly repo: string };
  /** The ref a session on this PR checks out ({@link pullRequestRef}). */
  readonly checkoutRef: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly commits: number;
  readonly mergeable: boolean | null;
  readonly timeline: ReadonlyArray<PullRequestTimelineItem>;
}

const author = (
  user:
    | { readonly login: string; readonly avatar_url: string }
    | null
    | undefined,
): PullRequestAuthor => ({
  login: user?.login ?? "ghost",
  avatarUrl: user?.avatar_url ?? "",
});

/**
 * Join GitHub's four reads into ONE page: the PR itself, its
 * conversation (`issues.listComments`), its verdicts
 * (`pulls.listReviews`), and the inline comments each verdict carried
 * (`pulls.listReviewComments`, grouped under their review). Inline
 * comments whose review is unknown (GitHub's synthetic single-comment
 * reviews the list omits) surface as a COMMENTED review of their own
 * so nothing an author said goes missing. Oldest first.
 */
export const buildPullRequestView = (
  repo: string,
  pull: GitHub.GetPullRequestResponse,
  comments: GitHub.ListIssueCommentsResponse,
  reviews: GitHub.ListPullRequestReviewsResponse,
  inline: GitHub.ListPullRequestReviewCommentsResponse,
): PullRequestView => {
  const inlineByReview = new Map<number, PullRequestInlineComment[]>();
  for (const comment of inline) {
    const reviewId = comment.pull_request_review_id ?? -comment.id;
    const list = inlineByReview.get(reviewId) ?? [];
    list.push({
      id: comment.id,
      author: author(comment.user),
      path: comment.path,
      line: comment.line ?? comment.original_line ?? undefined,
      startLine: comment.start_line ?? comment.original_start_line ?? undefined,
      body: comment.body,
      diffHunk: comment.diff_hunk,
      createdAt: comment.created_at,
      htmlUrl: comment.html_url,
      inReplyTo: comment.in_reply_to_id ?? undefined,
    });
    inlineByReview.set(reviewId, list);
  }

  const timeline: PullRequestTimelineItem[] = [];
  for (const comment of comments) {
    timeline.push({
      kind: "comment",
      id: comment.id,
      author: author(comment.user),
      body: comment.body ?? "",
      createdAt: comment.created_at,
      htmlUrl: comment.html_url,
    });
  }
  for (const review of reviews) {
    const own = inlineByReview.get(review.id) ?? [];
    inlineByReview.delete(review.id);
    // GitHub lists a PENDING or empty review row for every inline
    // comment batch — one with no body, no verdict, and no comments is
    // noise on the page
    if (
      review.state === "PENDING" ||
      ((review.body ?? "").length === 0 &&
        review.state === "COMMENTED" &&
        own.length === 0)
    ) {
      continue;
    }
    timeline.push({
      kind: "review",
      id: review.id,
      author: author(review.user),
      state: review.state,
      body: review.body ?? "",
      createdAt: review.submitted_at ?? "",
      htmlUrl: review.html_url,
      comments: own,
    });
  }
  // inline comments left over — their review is not in the list
  for (const own of inlineByReview.values()) {
    const first = own[0]!;
    timeline.push({
      kind: "review",
      id: -first.id,
      author: first.author,
      state: "COMMENTED",
      body: "",
      createdAt: first.createdAt,
      htmlUrl: first.htmlUrl,
      comments: own,
    });
  }
  timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    repo,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.merged
      ? "merged"
      : pull.draft
        ? "draft"
        : pull.state === "open"
          ? "open"
          : "closed",
    author: author(pull.user),
    htmlUrl: pull.html_url,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      repo: pull.head.repo?.full_name,
    },
    base: { ref: pull.base.ref, repo: pull.base.repo.full_name },
    checkoutRef: pullRequestRef(pull),
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    commits: pull.commits,
    mergeable: pull.mergeable,
    timeline,
  };
};
