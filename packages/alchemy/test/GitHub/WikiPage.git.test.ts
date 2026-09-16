import { fromToken } from "@/GitHub/Credentials.ts";
import { WikiPageProvider, type WikiPageProps } from "@/GitHub/WikiPage.ts";
import {
  deleteWikiPage,
  readWikiPage,
  syncWikiPage,
  wikiRepository,
  type WikiRepository,
} from "@/GitHub/WikiPageGit.ts";
import * as Provider from "@/Provider.ts";
import type { WikiPage } from "@/GitHub/WikiPage.ts";
import { exec } from "@/Util/exec.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const props: WikiPageProps = {
  owner: "alchemy-run-test",
  repository: "alchemy-pr-1578-wiki-unit",
  title: "Getting Started",
  content: "First revision",
  allowDelete: true,
};
const token = "wiki-fixture-secret";

const git = Effect.fn(
  function* (cwd: string, ...args: string[]) {
    const env = yield* Effect.sync(() => ({
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Wiki fixture",
      GIT_AUTHOR_EMAIL: "wiki-fixture@example.com",
      GIT_COMMITTER_NAME: "Wiki fixture",
      GIT_COMMITTER_EMAIL: "wiki-fixture@example.com",
    }));
    const result = yield* exec(
      ChildProcess.make("git", args, { cwd, env, extendEnv: false }),
    );
    expect(result.exitCode).toBe(0);
    return result.stdout;
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-wiki-fixture-",
  });
  const remote = path.join(directory, "fixture.wiki.git");
  const seed = path.join(directory, "seed");
  yield* git(directory, "init", "--bare", "--initial-branch=main", remote);
  yield* git(directory, "clone", remote, seed);
  yield* fs.writeFileString(
    path.join(seed, "Bootstrap.md"),
    "Unmanaged bootstrap page",
  );
  yield* git(seed, "add", "Bootstrap.md");
  yield* git(seed, "commit", "-m", "Bootstrap wiki");
  yield* git(seed, "push", "origin", "HEAD");
  const repository: WikiRepository = {
    remote,
    htmlUrl: `https://github.com/${props.owner}/${props.repository}/wiki`,
    token: Redacted.make(token),
  };
  return { fs, path, directory, seed, repository };
});

const describe = layer(NodeServices.layer, { excludeTestServices: true });

describe("WikiPage Git fixtures", (it) => {
  it.effect(
    "runs provider create, recovery, adoption, update, replacement, and delete against Git",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* fixture;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const remote = `https://github.com/${props.owner}/${props.repository}.wiki.git`;
        const localTransport = ChildProcessSpawner.make((command) =>
          spawner.spawn(
            command._tag === "StandardCommand"
              ? ChildProcess.make(
                  command.command,
                  command.args.map((arg) =>
                    arg === remote ? repository.remote : arg,
                  ),
                  command.options,
                )
              : command,
          ),
        );
        yield* Effect.gen(function* () {
          const provider =
            yield* Provider.Provider<WikiPage>("GitHub.WikiPage");
          const context = {
            id: "Page",
            fqn: "Page",
            instanceId: "fixture",
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
          };
          const created = yield* provider.reconcile({
            ...context,
            news: props,
            olds: undefined,
            output: undefined,
          });
          expect(
            yield* provider.read!({
              ...context,
              olds: props,
              output: undefined,
            }),
          ).toEqual(created);
          const adopted = yield* provider.reconcile({
            ...context,
            news: props,
            olds: undefined,
            output: created,
          });
          expect(adopted).toEqual(created);
          const news = { ...props, content: "Changed via provider" };
          const updated = yield* provider.reconcile({
            ...context,
            news,
            olds: props,
            output: adopted,
          });
          expect(updated.sha).not.toBe(created.sha);
          yield* provider.delete({
            ...context,
            olds: { ...news, allowDelete: undefined },
            output: updated,
          });
          expect(
            yield* provider.read!({
              ...context,
              olds: news,
              output: undefined,
            }),
          ).toEqual(updated);
          const renamed = { ...news, title: "Quick Start" };
          const replacement = yield* provider.reconcile({
            ...context,
            news: renamed,
            olds: undefined,
            output: undefined,
          });
          yield* provider.delete({ ...context, olds: news, output: updated });
          expect(
            yield* provider.read!({
              ...context,
              olds: news,
              output: undefined,
            }),
          ).toBeUndefined();
          expect(
            yield* provider.read!({
              ...context,
              olds: renamed,
              output: undefined,
            }),
          ).toEqual(replacement);
          yield* provider.delete({
            ...context,
            olds: renamed,
            output: replacement,
          });
          yield* provider.delete({
            ...context,
            olds: renamed,
            output: replacement,
          });
        }).pipe(
          Effect.provide(WikiPageProvider()),
          Effect.provide(fromToken(token)),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            localTransport,
          ),
        );
      }).pipe(Effect.scoped),
  );
  it.effect(
    "creates, recovers, updates, avoids no-op commits, and deletes idempotently",
    () =>
      Effect.gen(function* () {
        const { directory, repository } = yield* fixture;
        expect(yield* readWikiPage(repository, props)).toBeUndefined();
        const created = yield* syncWikiPage(repository, props);
        expect(created.pageName).toBe("Getting-Started");
        expect(created.htmlUrl).toBe(`${repository.htmlUrl}/Getting-Started`);
        expect(yield* readWikiPage(repository, props)).toEqual(created);
        expect(yield* syncWikiPage(repository, props)).toEqual(created);
        const updated = yield* syncWikiPage(repository, {
          ...props,
          content: "\n    Updated\n      indented\n",
          message: "Update fixture page",
        });
        expect(updated.sha).not.toBe(created.sha);
        expect(
          (yield* git(
            directory,
            "--git-dir",
            repository.remote,
            "log",
            "-1",
            "--format=%s",
          )).trim(),
        ).toBe("Update fixture page");
        expect(
          yield* git(
            directory,
            "--git-dir",
            repository.remote,
            "show",
            "HEAD:Getting-Started.md",
          ),
        ).toBe("Updated\n  indented");
        yield* deleteWikiPage(repository, props);
        yield* deleteWikiPage(repository, props);
        expect(yield* readWikiPage(repository, props)).toBeUndefined();
        expect(
          yield* git(
            directory,
            "--git-dir",
            repository.remote,
            "show",
            "HEAD:Bootstrap.md",
          ),
        ).toBe("Unmanaged bootstrap page");
        expect(
          (yield* git(
            directory,
            "--git-dir",
            repository.remote,
            "rev-list",
            "--count",
            "HEAD",
          )).trim(),
        ).toBe("4");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves by default and recreates an externally deleted page",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* fixture;
        const created = yield* syncWikiPage(repository, props);
        yield* deleteWikiPage(repository, { ...props, allowDelete: undefined });
        expect(yield* readWikiPage(repository, props)).toEqual(created);
        yield* deleteWikiPage(repository, props);
        const recreated = yield* syncWikiPage(repository, props);
        expect(recreated.sha).not.toBe(created.sha);
        expect(yield* readWikiPage(repository, props)).toEqual(recreated);
        yield* deleteWikiPage(repository, props);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "converges all formats, removes previous extensions, and preserves unrelated pages",
    () =>
      Effect.gen(function* () {
        const { directory, repository } = yield* fixture;
        const formats = {
          markdown: "md",
          asciidoc: "asciidoc",
          mediawiki: "mediawiki",
          org: "org",
          pod: "pod",
          rdoc: "rdoc",
          rest: "rst",
          textile: "textile",
        } as const;
        for (const format of Object.keys(formats) as Array<
          keyof typeof formats
        >) {
          const next = { ...props, format };
          const page = yield* syncWikiPage(repository, next);
          expect(yield* readWikiPage(repository, props)).toEqual(page);
          expect(
            (yield* git(
              directory,
              "--git-dir",
              repository.remote,
              "ls-tree",
              "--name-only",
              "HEAD",
            ))
              .trim()
              .split("\n"),
          ).toEqual(["Bootstrap.md", `Getting-Started.${formats[format]}`]);
        }
        yield* deleteWikiPage(repository, props);
        expect(yield* readWikiPage(repository, props)).toBeUndefined();
      }).pipe(Effect.scoped),
  );

  it.effect(
    "recovers alternate extensions and safely replaces symlink pages",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, seed, repository } = yield* fixture;
        yield* fs.writeFileString(
          path.join(seed, "Getting-Started.markdown"),
          "Existing page",
        );
        const outside = path.join(directory, "outside");
        yield* fs.writeFileString(outside, "Do not overwrite");
        yield* fs.symlink(outside, path.join(seed, "Linked.md"));
        yield* git(seed, "add", ".");
        yield* git(seed, "commit", "-m", "External pages");
        yield* git(seed, "push", "origin", "HEAD");
        expect(yield* readWikiPage(repository, props)).toBeDefined();
        yield* syncWikiPage(repository, props);
        yield* syncWikiPage(repository, { ...props, title: "Linked" });
        expect(yield* fs.readFileString(outside)).toBe("Do not overwrite");
        expect(
          (yield* git(
            directory,
            "--git-dir",
            repository.remote,
            "ls-tree",
            "HEAD",
            "Linked.md",
          )).startsWith("100644"),
        ).toBe(true);
        expect(
          (yield* git(
            directory,
            "--git-dir",
            repository.remote,
            "ls-tree",
            "--name-only",
            "HEAD",
          )).includes("Getting-Started.markdown"),
        ).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("retries concurrent pushes without losing sibling pages", () =>
    Effect.gen(function* () {
      const { repository } = yield* fixture;
      const titles = ["First", "Second", "Third"];
      yield* Effect.all(
        titles.map((title) => syncWikiPage(repository, { ...props, title })),
        { concurrency: 3 },
      );
      for (const title of titles)
        expect(
          yield* readWikiPage(repository, { ...props, title }),
        ).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reports unavailable repositories with actionable errors without skipping lifecycle work",
    () =>
      Effect.gen(function* () {
        const { directory, path, repository } = yield* fixture;
        const missing = {
          ...repository,
          remote: path.join(directory, "uninitialized.wiki.git"),
        };
        const result = yield* Effect.result(syncWikiPage(missing, props));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("WikiRepositoryUnavailable");
          expect(result.failure.message).toContain(
            "first page in the GitHub web UI",
          );
          expect(result.failure.message).not.toContain(token);
        }
        expect(yield* readWikiPage(missing, props)).toBeUndefined();
        yield* deleteWikiPage(missing, props);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps credentials out of arguments and config and removes temporary checkouts",
    () =>
      Effect.gen(function* () {
        const { fs, repository } = yield* fixture;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directories = new Set<string>();
        const safeSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag === "StandardCommand") {
              expect(command.args.join(" ")).not.toContain(token);
              expect(command.options.extendEnv).toBe(false);
              const env = command.options.env!;
              expect(env.GIT_CONFIG_KEY_0).toBe(
                `http.${repository.remote}.extraHeader`,
              );
              expect(env.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);
              expect(env.GIT_TRACE).toBeUndefined();
              directories.add(env.HOME!);
              expect(yield* fs.readFileString(env.GIT_CONFIG_GLOBAL!)).toBe("");
            }
            return yield* spawner.spawn(command);
          }),
        );
        yield* syncWikiPage(repository, props).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            safeSpawner,
          ),
        );
        expect(directories.size).toBe(1);
        for (const directory of directories)
          expect(yield* fs.exists(directory)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects unsafe titles and produces encoded browser URLs", () =>
    Effect.gen(function* () {
      const { repository } = yield* fixture;
      for (const title of [
        "../escape",
        "a/b",
        "a\\b",
        "",
        "..",
        " line",
        "line\nbreak",
      ]) {
        const result = yield* Effect.result(
          syncWikiPage(repository, { ...props, title }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("InvalidWikiPage");
      }
      const page = yield* syncWikiPage(repository, {
        ...props,
        title: "API #1?",
      });
      expect(page.htmlUrl).toBe(`${repository.htmlUrl}/API-%231%3F`);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "maps public, enterprise, and data-residency API hosts to Git hosts",
    () =>
      Effect.gen(function* () {
        const cases = [
          [undefined, "https://enterprise.example.com"],
          ["github.com", "https://github.com"],
          [
            "https://wiki.example.com:8443/api/v3",
            "https://wiki.example.com:8443",
          ],
          ["https://api.acme.ghe.com", "https://acme.ghe.com"],
        ] as const;
        for (const [baseUrl, origin] of cases) {
          const repository = yield* wikiRepository({ ...props, baseUrl });
          expect(repository.remote).toBe(
            `${origin}/${props.owner}/${props.repository}.wiki.git`,
          );
          expect(repository.htmlUrl).toBe(
            `${origin}/${props.owner}/${props.repository}/wiki`,
          );
        }
        const insecure = yield* Effect.result(
          wikiRepository({ ...props, baseUrl: "http://wiki.example.com" }),
        );
        expect(Result.isFailure(insecure)).toBe(true);
      }).pipe(
        Effect.provide(fromToken(token, { baseUrl: "enterprise.example.com" })),
      ),
  );

  it.effect(
    "replaces title, repository, owner, and host changes but updates formats in place",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Provider<WikiPage>("GitHub.WikiPage");
        const diff = (news: WikiPageProps) =>
          provider.diff!({
            id: "Page",
            fqn: "Page",
            instanceId: "fixture",
            olds: props,
            news,
            oldBindings: [],
            newBindings: [],
            output: undefined,
          });
        for (const news of [
          { ...props, title: "Renamed" },
          { ...props, repository: "other" },
          { ...props, owner: "alchemy-run-test-2" },
          { ...props, baseUrl: "enterprise.example.com" },
        ])
          expect(yield* diff(news)).toEqual({ action: "replace" });
        expect(yield* diff({ ...props, format: "asciidoc" })).toBeUndefined();
        expect(
          yield* diff({ ...props, title: "Getting-Started" }),
        ).toBeUndefined();
        expect(
          yield* diff({ ...props, baseUrl: "https://api.github.com" }),
        ).toBeUndefined();
      }).pipe(
        Effect.provide(WikiPageProvider()),
        Effect.provide(fromToken(token)),
      ),
  );
});
