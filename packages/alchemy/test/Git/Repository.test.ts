import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import * as Git from "@/Git/index.ts";
import * as Test from "@/Test/Alchemy";
/**
 * `Git.Repository` against a Git host running locally in workerd
 * (`dev: true`): create, update settings, replace on rename, destroy —
 * verified out-of-band over the host's REST API and with the real `git`
 * CLI using `Git.cloneCredentials`.
 */
import TestGitHost, { TEST_SECRET, TEST_USER, TestApi } from "./fixtures/stack.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Git.providers());

const { test } = Test.make({ providers, dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** The suite middleware's HTTP Basic credential (password = shared secret). */
const credentials: Git.RepositoryCredentials = {
  password: Redacted.make(TEST_SECRET),
};

const OWNER = TEST_USER.id;

/** Out-of-band typed client over the host's own contract. */
const adminClient = (url: string) =>
  HttpApiClient.make(TestApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(TEST_SECRET)),
  });

class StillThere extends Data.TaggedError("StillThere")<{ readonly status: string }> {}

/** Poll until the repo's async purge completes (404). */
const awaitGone = (url: string, name: string) =>
  Effect.gen(function* () {
    const client = yield* adminClient(url);
    yield* client.repos.get({ params: { owner: OWNER, repo: name } }).pipe(
      Effect.flatMap((repo) => Effect.fail(new StillThere({ status: repo.status }))),
      Effect.catchTag("RepoNotFound", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "StillThere",
        schedule: Schedule.spaced("500 millis"),
        times: 40,
      }),
    );
  });

class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message() {
    return `git ${this.args.join(" ")} → exit ${this.exitCode}\n${this.stderr.trim()}`;
  }
}

/** Run `git <args>` in `cwd`. Bounded. */
const git = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const handle = yield* ChildProcess.make("git", args, {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    extendEnv: true,
  });
  const [exitCode, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stderr)),
      Stream.runDrain(handle.stdout),
    ],
    { concurrency: 3 },
  );
  return { args, exitCode, stderr };
}, Effect.timeout("60 seconds"));

const mustGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode !== 0) return yield* new GitError(result);
  return result;
});

const mustFailGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode === 0) return yield* new GitError(result);
  return result;
});

/** `http://<username>:<password>@host/owner/name.git` from the helper's output. */
const authenticatedUrl = (creds: ReturnType<typeof Git.cloneCredentials>) =>
  Effect.sync(() => {
    const url = new URL(creds.url);
    url.username = creds.username;
    url.password = Redacted.value(creds.password);
    return url.toString();
  });

test.provider(
  "Git.Repository: create, update, clone, replace, destroy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();

      const deploy = (props: Partial<Git.RepositoryProps>) =>
        stack.deploy(
          Effect.gen(function* () {
            const host = yield* TestGitHost;
            const repo = yield* Git.Repository("Repo", {
              url: host.url.as<string>(),
              owner: OWNER,
              credentials,
              ...props,
            });
            return { url: host.url.as<string>(), repo };
          }),
        );

      // ── create ────────────────────────────────────────────────────────
      const v1 = yield* deploy({ description: "first" });
      expect(v1.url).toMatch(/^http:\/\/localhost:\d+$/);
      const name = v1.repo.name;
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(v1.repo).toMatchObject({
        owner: OWNER,
        fullName: `${OWNER}/${name}`,
        cloneUrl: `${v1.url}/${OWNER}/${name}.git`,
        defaultBranch: "main",
        visibility: "private",
        readOnly: false,
        description: "first",
      });

      const admin = yield* adminClient(v1.url);
      const observed1 = yield* admin.repos.get({ params: { owner: OWNER, repo: name } });
      expect(observed1.repoId).toBe(v1.repo.repoId);
      expect(observed1.description).toBe("first");
      expect(observed1.public).toBe(false);

      // ── git over the credentials helper ───────────────────────────────
      const remote = yield* authenticatedUrl(Git.cloneCredentials(v1.repo, credentials));
      const work = yield* fs.makeTempDirectory({ prefix: "git-repository-" });
      const a = path.join(work, "a");
      yield* mustGit(work, "clone", remote, a);
      yield* fs.writeFileString(path.join(a, "README.md"), "hello\n");
      yield* mustGit(a, "add", "README.md");
      yield* mustGit(a, "commit", "-m", "initial");
      yield* mustGit(a, "push", "origin", "HEAD:refs/heads/main");
      const b = path.join(work, "b");
      yield* mustGit(work, "clone", remote, b);
      expect(yield* fs.readFileString(path.join(b, "README.md"))).toBe("hello\n");
      // private: anonymous clone is refused
      yield* mustFailGit(work, "clone", v1.repo.cloneUrl, path.join(work, "anon-private"));

      // ── update: description + visibility ─────────────────────────────
      const v2 = yield* deploy({ description: "second", visibility: "public" });
      expect(v2.repo.repoId).toBe(v1.repo.repoId);
      expect(v2.repo.name).toBe(name);
      const observed2 = yield* admin.repos.get({ params: { owner: OWNER, repo: name } });
      expect(observed2.description).toBe("second");
      expect(observed2.public).toBe(true);
      // public: anonymous clone works
      yield* mustGit(work, "clone", v2.repo.cloneUrl, path.join(work, "anon-public"));

      // ── update: read-only rejects pushes ─────────────────────────────
      yield* deploy({ description: "second", visibility: "public", readOnly: true });
      const observed3 = yield* admin.repos.get({ params: { owner: OWNER, repo: name } });
      expect(observed3.readOnly).toBe(true);
      yield* fs.writeFileString(path.join(a, "README.md"), "again\n");
      yield* mustGit(a, "commit", "-am", "second");
      yield* mustFailGit(a, "push", "origin", "HEAD:refs/heads/main");

      // ── replace: an explicit, different name is a new repository ────
      const renamed = `${name.slice(0, 80)}-renamed`;
      const v4 = yield* deploy({ name: renamed, description: "renamed" });
      expect(v4.repo.name).toBe(renamed);
      expect(v4.repo.repoId).not.toBe(v1.repo.repoId);
      const observed4 = yield* admin.repos.get({ params: { owner: OWNER, repo: renamed } });
      expect(observed4.description).toBe("renamed");
      yield* awaitGone(v1.url, name);

      // ── destroy ───────────────────────────────────────────────────────
      // The host is torn down with the stack, so verify the repo's delete
      // while the host is still up: drop just the repository first.
      yield* stack.deploy(
        Effect.gen(function* () {
          const host = yield* TestGitHost;
          return { url: host.url.as<string>() };
        }),
      );
      yield* awaitGone(v1.url, renamed);

      yield* stack.destroy();
      yield* fs.remove(work, { recursive: true });
    }).pipe(logLevel),
  { timeout: 180_000 },
);
