/* ── the PR's files, as the server pages them ─────────────────────────
   GitHub's whole-PR diff refuses changes over 20 000 lines or 300
   files, so `GET /api/prs/:n/files?page=k` pages through
   `pulls.listFiles` — each file arriving with its own hunks, which the
   UI dresses back up as a `diff --git` block to render. The shapes and
   the re-dressing are the server's (src/github/PullRequest.ts) — that
   module's only import is type-level, so it costs the bundle nothing. */

import {
  toGitDiff,
  type PullRequestChangedFile,
  type PullRequestFilesPage,
} from "../../src/github/PullRequest.ts";

export type ChangedFile = PullRequestChangedFile;
export type ChangedFilesPage = PullRequestFilesPage;
export { toGitDiff };

/**
 * Files over this many changed lines are not rendered until asked —
 * GitHub's "Large diffs are not rendered by default", and what keeps a
 * 20 000-line PR from freezing the tab on open.
 */
export const LARGE_FILE_LINES = 1_000;

/** Page through `/api/prs/:n/files`, handing over each page as it
 *  lands, until the last one (or `signal` aborts). Throws on the first
 *  failed page with the server's message. */
export const fetchChangedFiles = async (
  number: number,
  onPage: (page: ChangedFilesPage) => void,
  signal: AbortSignal,
): Promise<void> => {
  let page: number | null = 1;
  while (page !== null && !signal.aborted) {
    const response = await fetch(`/api/prs/${number}/files?page=${page}`, {
      signal,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(data.error ?? response.statusText);
    }
    const body = (await response.json()) as ChangedFilesPage;
    if (signal.aborted) return;
    onPage(body);
    page = body.next;
  }
};
