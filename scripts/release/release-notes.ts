#!/usr/bin/env bun
/**
 * Prepend release notes for a tag to CHANGELOG.md. Idempotent: if the tag
 * already appears as a heading in CHANGELOG.md, does nothing.
 *
 * Usage: bun scripts/release/release-notes.ts v2.0.0-beta.13
 *
 * This wraps `changelogithub` but replaces its markdown generator so that
 * conventional-commit scopes containing `/` (e.g. `fix(aws/lambda): ...`)
 * render as nested categories under a shared top-level scope rather than
 * as flat, unrelated groups. For example:
 *
 *   feat(aws/lambda): ...
 *   fix(aws/s3): ...
 *   fix(aws): ...
 *
 * renders as:
 *
 *   - **aws**:
 *     - **lambda**: ...
 *     - **s3**: ...
 *     - ...
 */
import { $ } from "bun";
import { generate } from "changelogithub";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const tag = process.argv[2];
if (!tag) {
  console.error("Usage: bun scripts/release/release-notes.ts <tag>");
  process.exit(1);
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const existing = await readFile(changelogPath, "utf-8");
if (existing.includes(`## ${tag}\n`)) {
  console.log(`${tag} already in CHANGELOG.md, skipping`);
  process.exit(0);
}

// changelogithub uses `to` as a git revision in `git log <from>...<to>`.
// In the commit-then-tag flow this script runs BEFORE the tag is created,
// so resolve the revision to HEAD while keeping the tag string for the
// markdown heading. If the tag already exists locally (resumed run), use
// it so the diff is stable.
const tagExists =
  (await $`git rev-parse --verify ${`refs/tags/${tag}`}`.nothrow().quiet())
    .exitCode === 0;
const toRev = tagExists ? tag : "HEAD";

console.log(`Generating release notes for ${tag} (using ${toRev})`);
const { commits, config } = await generate({
  to: toRev,
  emoji: true,
  contributors: true,
  repo: "alchemy-run/alchemy-effect",
});

const md = renderMarkdown(commits, config);

await writeFile(
  changelogPath,
  `## ${tag}\n\n${md}\n\n---\n\n${existing}`,
);

// ---------------------------------------------------------------------------
// Custom markdown renderer. Mirrors the output of changelogithub's built-in
// generator but groups scopes hierarchically by splitting on `/`.
// ---------------------------------------------------------------------------

type Commit = (typeof commits)[number] & {
  resolvedAuthors?: Array<{ login?: string; name: string }>;
};
type Config = typeof config;

const emojisRE =
  /([\u2700-\u27BF\uE000-\uF8FF\u2011-\u26FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD10-\uDDFF])/g;

function renderMarkdown(commits: Commit[], config: Config): string {
  const lines: string[] = [];
  const [breaking, rest] = partition(commits, (c) => c.isBreaking);

  if (config.titles?.breakingChanges) {
    lines.push(...renderSection(breaking, config.titles.breakingChanges, config));
  }

  const byType = groupBy(rest, (c) => c.type);
  for (const type of Object.keys(config.types)) {
    const items = byType[type] || [];
    lines.push(...renderSection(items, config.types[type].title, config));
  }

  if (!lines.length) lines.push("*No significant changes*");

  const url = `https://${config.baseUrl}/${config.repo}/compare/${config.from}...${config.to}`;
  lines.push("", `##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](${url})`);

  return lines.join("\n").trim();
}

function renderSection(
  commits: Commit[],
  sectionName: string,
  config: Config,
): string[] {
  if (!commits.length) return [];
  const out: string[] = ["", formatTitle(sectionName, config), ""];

  // Build a tree keyed by the `/`-separated scope segments. Commits attach
  // to the deepest node that matches their scope exactly.
  const root = makeNode();
  for (const commit of commits) {
    const scope = (commit.scope ?? "").trim();
    const mapped = config.scopeMap?.[scope] ?? scope;
    const segments = mapped ? mapped.split("/").map((s) => s.trim()).filter(Boolean) : [];
    let node = root;
    for (const seg of segments) {
      node.children[seg] ??= makeNode();
      node = node.children[seg];
    }
    node.commits.push(commit);
  }

  out.push(...renderNode(root, 0, config));
  return out;
}

interface Node {
  commits: Commit[];
  children: Record<string, Node>;
}

function makeNode(): Node {
  return { commits: [], children: {} };
}

function renderNode(node: Node, depth: number, config: Config): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);

  // Sort scope-less commits first so unscoped entries sit above scoped ones,
  // matching changelogithub's default ordering.
  for (const commit of [...node.commits].reverse()) {
    lines.push(`${pad}- ${formatLine(commit, config)}`);
  }

  const childNames = Object.keys(node.children).sort();
  for (const name of childNames) {
    const child = node.children[name];
    const label = `**${name}**`;

    // Collapse: a child with a single commit and no further descendants
    // renders inline as `- **name**: description` rather than introducing a
    // separate header line. This matches changelogithub's behavior when
    // `group === 'multiple'` and keeps single-item scopes compact.
    const childCommitCount = countCommits(child);
    const hasGrandchildren = Object.keys(child.children).length > 0;
    if (childCommitCount === 1 && !hasGrandchildren) {
      const [commit] = child.commits;
      lines.push(`${pad}- ${label}: ${formatLine(commit, config)}`);
      continue;
    }

    lines.push(`${pad}- ${label}:`);
    lines.push(...renderNode(child, depth + 1, config));
  }

  return lines;
}

function countCommits(node: Node): number {
  let n = node.commits.length;
  for (const child of Object.values(node.children)) n += countCommits(child);
  return n;
}

function formatTitle(name: string, config: Config): string {
  if (!config.emoji) name = name.replace(emojisRE, "");
  return `### &nbsp;&nbsp;&nbsp;${name.trim()}`;
}

function formatLine(commit: Commit, config: Config): string {
  const prRefs = formatReferences(commit.references, config, "issues");
  const hashRefs = formatReferences(commit.references, config, "hash");
  const authorNames = [
    ...new Set(
      (commit.resolvedAuthors ?? []).map((a) =>
        a.login ? `@${a.login}` : `**${a.name}**`,
      ),
    ),
  ];
  const authors = joinWithAnd(authorNames).trim();
  const authorStr = authors ? `by ${authors}` : "";
  let refs = [authorStr, prRefs, hashRefs]
    .filter((s) => s && s.trim())
    .join(" ");
  if (refs) refs = `&nbsp;-&nbsp; ${refs}`;
  const description = config.capitalize
    ? capitalize(commit.description)
    : commit.description;
  return [description, refs].filter((s) => s && s.trim()).join(" ");
}

function formatReferences(
  references: Commit["references"],
  config: Config,
  kind: "issues" | "hash",
): string {
  const baseUrl = config.baseUrl;
  const repo = config.repo;
  const refs = references
    .filter((r) =>
      kind === "issues"
        ? r.type === "issue" || r.type === "pull-request"
        : r.type === "hash",
    )
    .map((ref) => {
      if (!repo) return ref.value;
      if (ref.type === "pull-request" || ref.type === "issue") {
        return `https://${baseUrl}/${repo}/issues/${ref.value.slice(1)}`;
      }
      return `[<samp>(${ref.value.slice(0, 5)})</samp>](https://${baseUrl}/${repo}/commit/${ref.value})`;
    });
  const joined = joinWithAnd(refs).trim();
  if (kind === "issues") return joined ? `in ${joined}` : "";
  return joined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinWithAnd(
  array: string[],
  glue = ", ",
  finalGlue = " and ",
): string {
  if (!array || array.length === 0) return "";
  if (array.length === 1) return array[0];
  if (array.length === 2) return array.join(finalGlue);
  return `${array.slice(0, -1).join(glue)}${finalGlue}${array.slice(-1)}`;
}

function partition<T>(items: T[], pred: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (pred(item) ? yes : no).push(item);
  return [yes, no];
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
