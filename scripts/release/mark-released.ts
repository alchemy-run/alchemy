// Comments "Released in <tag>" on every PR in a release, and on the issues
// those PRs closed.
//
// The PRs are the `(#NNN)` suffixes on the squash-merge subjects between the
// previous tag and this one. Each comment carries a hidden marker, so a PR or
// issue that already has one is skipped and a failed run can be re-run.
//
// Reads `ALCHEMY_REPO` (`<owner>/<repo>`) for the comment links.
//
// Usage: bun scripts/release/mark-released.ts <tag> [--dry-run]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag } from "effect/cli";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number;
}> {}

export class InvalidRepo extends Data.TaggedError("InvalidRepo")<{
  readonly message: string;
}> {}

const MARKER = "<!-- alchemy-release -->";

/** Runs a command and returns its stdout, failing on a non-zero exit. */
const run = Effect.fn(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner;
  const { stdout, exitCode } = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdout: "pipe", stderr: "inherit" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.trim(), exitCode: Number(exitCode) };
    }),
  );
  if (exitCode !== 0) {
    return yield* new CommandFailed({
      message: `${command} ${args.slice(0, 2).join(" ")} exited with code ${exitCode}`,
      command,
      exitCode,
    });
  }
  return stdout;
});

/** `ALCHEMY_REPO`, as `<owner>/<repo>`. */
const repository = Effect.gen(function* () {
  const repo = (yield* Config.String("ALCHEMY_REPO")).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return yield* new InvalidRepo({
      message: `ALCHEMY_REPO must be <owner>/<repo> (got: ${repo})`,
    });
  }
  return repo;
});

/** PR numbers from the `(#NNN)` suffixes of the squash merges in `from..to`. */
const releasedPullRequests = Effect.fn(function* (from: string, to: string) {
  const subjects = yield* run("git", ["log", `${from}..${to}`, "--format=%s"]);
  const numbers = new Set<number>();
  for (const subject of subjects.split("\n")) {
    const match = /\(#(\d+)\)\s*$/.exec(subject);
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
});

/** The issues in this repo a PR closed through `Fixes #N`-style references. */
const closedIssues = Effect.fn(function* (repo: string, pr: number) {
  const [owner, name] = repo.split("/");
  const out = yield* run("gh", [
    "api",
    "graphql",
    "-f",
    `query=query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } }
        }
      }
    }`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `pr=${pr}`,
    "--jq",
    `.data.repository.pullRequest.closingIssuesReferences.nodes[] | select(.repository.nameWithOwner == "${repo}") | .number`,
  ]);
  return out === "" ? [] : out.split("\n").map(Number);
});

const alreadyMarked = Effect.fn(function* (repo: string, number: number) {
  const out = yield* run("gh", [
    "api",
    "--paginate",
    `repos/${repo}/issues/${number}/comments`,
    "--jq",
    `.[] | select(.body | contains("${MARKER}")) | .id`,
  ]);
  return out !== "";
});

const command = Command.make(
  "mark-released",
  {
    tag: Argument.String("tag").pipe(Argument.withDescription("Release tag, e.g. v2.0.0-beta.85")),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the PRs and issues without commenting"),
    ),
  },
  Effect.fn(function* ({ tag, dryRun }) {
    const repo = yield* repository;
    const from = yield* run("git", ["describe", "--tags", "--abbrev=0", `${tag}^`]);
    const prs = yield* releasedPullRequests(from, tag);
    const closed = new Set<number>();
    for (const pr of prs) {
      for (const issue of yield* closedIssues(repo, pr)) closed.add(issue);
    }
    const issues = [...closed].sort((a, b) => a - b);

    yield* Console.log(
      `${tag} (from ${from}): PRs ${prs.map((n) => `#${n}`).join(", ") || "none"}; ` +
        `issues ${issues.map((n) => `#${n}`).join(", ") || "none"}`,
    );
    if (dryRun) return;

    const link = `[${tag}](https://github.com/${repo}/releases/tag/${tag})`;
    const targets = [
      ...prs.map((number) => ({ number, body: `🚀 Released in ${link}.` })),
      ...issues.map((number) => ({ number, body: `🚀 Shipped in ${link}.` })),
    ];
    for (const { number, body } of targets) {
      if (yield* alreadyMarked(repo, number)) {
        yield* Console.log(`#${number} already marked, skipping`);
        continue;
      }
      yield* run("gh", [
        "api",
        `repos/${repo}/issues/${number}/comments`,
        "-f",
        `body=${body}\n\n${MARKER}`,
      ]);
      yield* Console.log(`Marked #${number}`);
    }
  }),
).pipe(Command.withDescription("Comment the release tag on every PR and issue it shipped"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
