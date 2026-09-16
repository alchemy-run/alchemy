import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { dedent } from "../Util/dedent.ts";
import { exec } from "../Util/exec.ts";
import { GitHubCredentials } from "./Credentials.ts";
import { effectiveGitHubBaseUrl } from "./Octokit.ts";
import type { WikiPage, WikiPageProps } from "./WikiPage.ts";

export class WikiRepositoryUnavailable extends Data.TaggedError(
  "WikiRepositoryUnavailable",
)<{ readonly message: string }> {}

export class WikiGitError extends Data.TaggedError("WikiGitError")<{
  readonly operation: string;
  readonly reason: "missing" | "conflict" | "command";
  readonly message: string;
}> {}

export class InvalidWikiPage extends Data.TaggedError("InvalidWikiPage")<{
  readonly message: string;
}> {}

const extensions = {
  markdown: ["md", "markdown", "mdown", "mkdn", "mkd"],
  asciidoc: ["asciidoc", "adoc", "asc"],
  mediawiki: ["mediawiki", "wiki"],
  org: ["org"],
  pod: ["pod"],
  rdoc: ["rdoc"],
  rest: ["rst", "rest"],
  textile: ["textile"],
} as const;

export interface WikiRepository {
  readonly remote: string;
  readonly htmlUrl: string;
  readonly token: Redacted.Redacted<string>;
}

const pageNameFor = (title: string) =>
  Effect.gen(function* () {
    if (
      title.trim() !== title ||
      title.length === 0 ||
      /[\x00-\x1f\x7f/\\]/.test(title) ||
      title === "." ||
      title === ".."
    ) {
      return yield* new InvalidWikiPage({
        message:
          "Wiki page titles must be nonempty, trimmed names without path separators or control characters.",
      });
    }
    return title.replace(/\s+/g, "-");
  });

export const wikiRepository = Effect.fn(function* (props: WikiPageProps) {
  yield* pageNameFor(props.title);
  if (
    ![props.owner, props.repository].every(
      (part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
    )
  ) {
    return yield* new InvalidWikiPage({
      message:
        "Wiki owner and repository must be GitHub names, not paths or URLs.",
    });
  }
  const baseUrl = yield* effectiveGitHubBaseUrl(props.baseUrl);
  const origin = yield* Effect.sync(() => {
    const url = new URL(baseUrl ?? "https://github.com");
    if (url.hostname.startsWith("api.") && url.hostname.endsWith(".ghe.com")) {
      url.hostname = url.hostname.slice(4);
    }
    return url.origin;
  });
  if (!origin.startsWith("https://")) {
    return yield* new InvalidWikiPage({
      message: "Wiki Git authentication requires an HTTPS GitHub host.",
    });
  }
  const credentials = yield* yield* GitHubCredentials;
  const repositoryUrl = `${origin}/${props.owner}/${props.repository}`;
  return {
    remote: `${repositoryUrl}.wiki.git`,
    htmlUrl: `${repositoryUrl}/wiki`,
    token: credentials.token,
  } satisfies WikiRepository;
});

// Only the transient process environment contains the authorization header.
const gitEnvironment = Effect.fn(function* (
  repository: WikiRepository,
  directory: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const config = path.join(directory, "gitconfig");
  yield* fs.writeFileString(config, "");
  return yield* Effect.sync(() => ({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: directory,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${repository.remote}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${Redacted.value(repository.token)}`).toString("base64")}`,
    GIT_AUTHOR_NAME: "Alchemy",
    GIT_AUTHOR_EMAIL: "alchemy@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Alchemy",
    GIT_COMMITTER_EMAIL: "alchemy@users.noreply.github.com",
  }));
});

const git = Effect.fn(
  function* (
    directory: string,
    env: Record<string, string | undefined>,
    ...args: string[]
  ) {
    const operation = args[0]!;
    const result = yield* exec(
      ChildProcess.make(
        "git",
        [
          "--literal-pathspecs",
          "-c",
          "credential.helper=",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "http.followRedirects=false",
          ...args,
        ],
        { cwd: directory, env, extendEnv: false },
      ),
    ).pipe(
      Effect.mapError(
        () =>
          new WikiGitError({
            operation,
            reason: "command",
            message: `Unable to run git ${operation}. Ensure Git is installed and executable.`,
          }),
      ),
    );
    if (result.exitCode !== 0) {
      const reason =
        /Repository not found|repository '.+' (?:not found|does not exist)|does not appear to be a git repository/i.test(
          result.stderr,
        )
          ? "missing"
          : operation === "push" &&
              /\[rejected\]|cannot lock ref|failed to update ref/i.test(
                result.stderr,
              )
            ? "conflict"
            : "command";
      // Git diagnostics can include server-controlled text or credentials.
      return yield* new WikiGitError({
        operation,
        reason,
        message: `git ${operation} failed (exit ${result.exitCode}). Check repository access and GitHub token permissions.`,
      });
    }
    return result.stdout;
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
);

const checkout = Effect.fn(function* (repository: WikiRepository) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-wiki-",
  });
  const env = yield* gitEnvironment(repository, directory);
  yield* git(
    directory,
    env,
    "clone",
    "--quiet",
    "--",
    repository.remote,
    "wiki",
  ).pipe(
    Effect.catchTag("WikiGitError", (error) =>
      Effect.fail(
        error.reason === "missing"
          ? new WikiRepositoryUnavailable({
              message: `Cannot access ${repository.htmlUrl}. Enable the repository wiki and create its first page in the GitHub web UI before deploying WikiPage. Git cannot initialize a GitHub wiki that has never had a page. If it is already initialized, verify the repository name and token's repository access.`,
            })
          : error,
      ),
    ),
  );
  const cwd = path.join(directory, "wiki");
  const run = (...args: string[]) => git(cwd, env, ...args);
  const files = (yield* run("ls-files", "-z")).split("\0").filter(Boolean);
  return { cwd, run, files };
});

type Checkout = Effect.Success<ReturnType<typeof checkout>>;

const pageFiles = (files: string[], pageName: string) =>
  Object.values(extensions)
    .flatMap((formats) =>
      formats.map((extension) => `${pageName}.${extension}`),
    )
    .filter((file) => files.includes(file));

const attributes = Effect.fn(function* (
  repository: WikiRepository,
  props: WikiPageProps,
  wiki: Checkout,
  file: string,
) {
  return {
    title: props.title,
    pageName: props.title.replace(/\s+/g, "-"),
    htmlUrl: `${repository.htmlUrl}/${encodeURIComponent(props.title.replace(/\s+/g, "-"))}`,
    sha: (yield* wiki.run("log", "-1", "--format=%H", "--", file)).trim(),
  } satisfies WikiPage["Attributes"];
});

export const readWikiPage = Effect.fn(
  function* (repository: WikiRepository, props: WikiPageProps) {
    const pageName = yield* pageNameFor(props.title);
    const wiki = yield* checkout(repository);
    const files = pageFiles(wiki.files, pageName);
    const desired = `${pageName}.${extensions[props.format ?? "markdown"][0]}`;
    const file = files.includes(desired) ? desired : files[0];
    return file === undefined
      ? undefined
      : yield* attributes(repository, props, wiki, file);
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.catchTag("WikiRepositoryUnavailable", () =>
        Effect.succeed(undefined),
      ),
    ),
);

const retryConcurrentPush = <A, E, R>(
  effect: Effect.Effect<A, E | WikiGitError, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error instanceof WikiGitError && error.reason === "conflict",
      schedule: Schedule.spaced("200 millis"),
      times: 3,
    }),
    Effect.timeout("60 seconds"),
  );

export const syncWikiPage = Effect.fn(
  function* (repository: WikiRepository, props: WikiPageProps) {
    const pageName = yield* pageNameFor(props.title);
    const wiki = yield* checkout(repository);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = pageFiles(wiki.files, pageName);
    const file = `${pageName}.${extensions[props.format ?? "markdown"][0]}`;
    const content = dedent(props.content);
    const observed = wiki.files.includes(file)
      ? yield* wiki.run("show", `HEAD:${file}`)
      : undefined;
    const mode = wiki.files.includes(file)
      ? yield* wiki.run("ls-files", "--stage", "--", file)
      : "";
    if (
      observed !== content ||
      files.some((existing) => existing !== file) ||
      mode.startsWith("120000")
    ) {
      if (files.length > 0) yield* wiki.run("rm", "--", ...files);
      yield* fs.writeFileString(path.join(wiki.cwd, file), content);
      yield* wiki.run("add", "--", file);
      yield* wiki.run(
        "commit",
        "--quiet",
        "-m",
        props.message ?? `Update ${props.title}`,
      );
      yield* wiki.run("push", "--quiet", "origin", "HEAD");
    }
    return yield* attributes(repository, props, wiki, file);
  },
  Effect.scoped,
  retryConcurrentPush,
);

export const deleteWikiPage = Effect.fn(
  function* (repository: WikiRepository, props: WikiPageProps) {
    if (!props.allowDelete) return;
    const pageName = yield* pageNameFor(props.title);
    const wiki = yield* checkout(repository);
    const files = pageFiles(wiki.files, pageName);
    if (files.length === 0) return;
    yield* wiki.run("rm", "--", ...files);
    yield* wiki.run("commit", "--quiet", "-m", `Delete ${props.title}`);
    yield* wiki.run("push", "--quiet", "origin", "HEAD");
  },
  Effect.scoped,
  retryConcurrentPush,
  (effect) =>
    effect.pipe(
      Effect.catchTag("WikiRepositoryUnavailable", () => Effect.void),
    ),
);
