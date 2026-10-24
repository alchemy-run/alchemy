/**
 * Release-note generation: `git log` → changelogen's conventional-commit
 * parser → `render.ts`.
 *
 * This used to be changelogithub, but only its commit-range read, parser and
 * author dedupe were used (no GitHub token was ever passed, so authors were
 * never resolved to logins), and it pins an old changelogen that drags in
 * deprecated `tar@6`. What's left of it is the defaults below.
 *
 * The log is read through a pipe rather than a fixed buffer: `git log …
 * --name-status` prints every changed path of every commit in the range, so a
 * release spanning one repo-wide refactor overflows `execSync`'s 1 MB default
 * and the release dies at the tagging step having already bumped versions.
 */
import { parseCommits, type GitCommit, type RawGitCommit } from "changelogen";
import { renderMarkdown, type RenderConfig } from "./render.ts";

export interface Commit extends GitCommit {
  /** Commit authors (incl. co-authors), deduped by email, bots dropped. */
  resolvedAuthors: Array<{ name: string; email: string }>;
}

export interface ChangelogOptions {
  /** Start of the range. Defaults to the closest tag before `to`. */
  from?: string;
  to: string;
  /** `<owner>/<repo>`. */
  repo: string;
}

const defaults = {
  types: {
    feat: { title: "🚀 Features" },
    fix: { title: "🐞 Bug Fixes" },
    perf: { title: "🏎 Performance" },
  },
  titles: { breakingChanges: "🚨 Breaking Changes" },
  emoji: true,
  capitalize: true,
  baseUrl: "github.com",
  scopeMap: {} as Record<string, string>,
};

const excludeAuthors = [/\[bot\]/i, /dependabot/i, /\(bot\)/i];

const git = async (args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

/** The tag closest to `to`, excluding a tag on `to` itself. */
const previousTag = async (to: string) => {
  const { stdout, exitCode } = await git(["describe", "--tags", "--abbrev=0", `${to}^`]);
  return exitCode === 0 ? stdout.trim() : undefined;
};

/**
 * Same command and record format as changelogen's `getGitDiff` (the `----`
 * separator and `|`-delimited header are what `parseCommits` expects).
 */
export const getGitDiff = async (
  from: string | undefined,
  to = "HEAD",
): Promise<RawGitCommit[]> => {
  const { stdout, stderr, exitCode } = await git([
    "--no-pager",
    "log",
    `${from ? `${from}...` : ""}${to}`,
    "--pretty=----%n%s|%h|%an|%ae%n%b",
    "--name-status",
  ]);
  if (exitCode !== 0) {
    throw new Error(`git log ${from ?? ""}...${to} failed: ${stderr.trim()}`);
  }
  return stdout
    .trim()
    .split("----\n")
    .splice(1)
    .map((line) => {
      const [firstLine, ..._body] = line.split("\n");
      const [message, shortHash, authorName, authorEmail] = (firstLine ?? "").split("|");
      return {
        message: message ?? "",
        shortHash: shortHash ?? "",
        author: { name: authorName ?? "", email: authorEmail ?? "" },
        body: _body.join("\n"),
      };
    });
};

/** Attaches `resolvedAuthors`, keeping the first name seen per email. */
const resolveAuthors = (commits: GitCommit[]): Commit[] => {
  const byEmail = new Map<string, { name: string; email: string }>();
  return commits.map((commit) => ({
    ...commit,
    resolvedAuthors: commit.authors.flatMap((a) => {
      if (!a.email || !a.name || excludeAuthors.some((re) => re.test(a.name))) return [];
      if (!byEmail.has(a.email)) byEmail.set(a.email, { name: a.name, email: a.email });
      return [byEmail.get(a.email)!];
    }),
  }));
};

export const generate = async (options: ChangelogOptions) => {
  const from = options.from ?? (await previousTag(options.to));
  const config: RenderConfig = {
    ...defaults,
    repo: options.repo,
    from: from ?? "",
    to: options.to,
  };
  const commits = resolveAuthors(parseCommits(await getGitDiff(from, options.to), config as never));
  return { config, commits, md: renderMarkdown(commits, config) };
};
