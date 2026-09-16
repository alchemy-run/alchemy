import * as GitHub from "@/GitHub/index.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (!["alchemy-run-test", "alchemy-run-test-2"].includes(owner)) {
  throw new Error(
    "GITHUB_TEST_OWNER must be alchemy-run-test or alchemy-run-test-2",
  );
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

// Repositories are retained because the testing token lacks delete_repo.
const fixture = (suffix: string) =>
  GitHub.Repository("Repo", {
    owner,
    name: `alchemy-pr-1578-wiki-${suffix}`,
    visibility: "public",
    hasWiki: true,
    autoInit: true,
  });

const repoNameOf = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!);

const git = Effect.fn(
  function* (cwd: string, ...args: string[]) {
    const handle = yield* ChildProcess.make("git", args, {
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0" },
      extendEnv: true,
    });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: 3 },
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`git ${args[0]} exited ${exitCode}: ${stderr}`),
      );
    }
    return stdout;
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
);

// Read the public wiki's Git repository independently of the resource provider.
const getPage = (repository: string, title: string, extension = "md") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Effect.sync(() => process.cwd());
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: cwd,
      prefix: ".wiki-test-",
    });
    yield* git(
      directory,
      "clone",
      "--quiet",
      `https://github.com/${owner}/${repository}.wiki.git`,
      "wiki",
    );
    const wiki = path.join(directory, "wiki");
    const file = `${title.replace(/\s+/g, "-")}.${extension}`;
    if (!(yield* fs.exists(path.join(wiki, file)))) return undefined;
    return {
      content: yield* fs.readFileString(path.join(wiki, file)),
      sha: (yield* git(wiki, "log", "-1", "--format=%H", "--", file)).trim(),
    };
  }).pipe(Effect.scoped);

test.provider(
  "create and update wiki page",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (content: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* fixture("lifecycle");
            const page = yield* GitHub.WikiPage("Page", {
              owner,
              repository: repoNameOf(repo),
              title: "Home",
              content,
              allowDelete: true,
            });
            return { repo, page };
          }),
        );

      const created = yield* deploy("Welcome to the wiki!");
      expect(created.page.title).toBe("Home");
      expect(created.page.pageName).toBe("Home");
      expect(created.page.htmlUrl).toBe(
        `https://github.com/${owner}/alchemy-pr-1578-wiki-lifecycle/wiki/Home`,
      );
      expect(
        (yield* getPage("alchemy-pr-1578-wiki-lifecycle", "Home"))?.content,
      ).toBe("Welcome to the wiki!");

      const updated = yield* deploy("# Updated Content\n\nThis is updated!");
      expect(updated.page.sha).not.toBe(created.page.sha);
      expect(
        (yield* getPage("alchemy-pr-1578-wiki-lifecycle", "Home"))?.content,
      ).toBe("# Updated Content\n\nThis is updated!");

      yield* stack.destroy();
      expect(
        yield* getPage("alchemy-pr-1578-wiki-lifecycle", "Home"),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "create page with custom format",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* fixture("format");
          return yield* GitHub.WikiPage("Page", {
            owner,
            repository: repoNameOf(repo),
            title: "API Documentation",
            content: `
              = API Documentation

              == Overview

              The API provides...
            `,
            format: "asciidoc",
            message: "Add API documentation",
            allowDelete: true,
          });
        }),
      );
      expect(result.title).toBe("API Documentation");
      expect(result.pageName).toBe("API-Documentation");
      expect(
        (yield* getPage(
          "alchemy-pr-1578-wiki-format",
          "API Documentation",
          "asciidoc",
        ))?.content,
      ).toBe("= API Documentation\n\n== Overview\n\nThe API provides...");
      yield* stack.destroy();
      expect(
        yield* getPage(
          "alchemy-pr-1578-wiki-format",
          "API Documentation",
          "asciidoc",
        ),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "preserve page when allowDelete is false (default)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (allowDelete?: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* fixture("preserve");
            return yield* GitHub.WikiPage("Page", {
              owner,
              repository: repoNameOf(repo),
              title: "Documentation",
              content: "Important documentation that should be preserved",
              allowDelete,
            });
          }),
        );
      const created = yield* deploy();
      yield* stack.destroy();
      const retained = yield* getPage(
        "alchemy-pr-1578-wiki-preserve",
        "Documentation",
      );
      expect(retained?.sha).toBe(created.sha);
      expect(retained?.content).toBe(
        "Important documentation that should be preserved",
      );

      // Re-manage the retained page with deletion enabled to verify cleanup.
      yield* deploy(true);
      yield* stack.destroy();
      expect(
        yield* getPage("alchemy-pr-1578-wiki-preserve", "Documentation"),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "replace page when title changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (title: string, content: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* fixture("replace");
            return yield* GitHub.WikiPage("Page", {
              owner,
              repository: repoNameOf(repo),
              title,
              content,
              allowDelete: true,
            });
          }),
        );
      const created = yield* deploy("Getting Started", "Original guide");
      expect(created.title).toBe("Getting Started");
      const replaced = yield* deploy(
        "Quick Start",
        "New guide with different title",
      );
      expect(replaced.title).toBe("Quick Start");
      expect(replaced.pageName).toBe("Quick-Start");
      expect(
        yield* getPage("alchemy-pr-1578-wiki-replace", "Getting Started"),
      ).toBeUndefined();
      expect(
        (yield* getPage("alchemy-pr-1578-wiki-replace", "Quick Start"))
          ?.content,
      ).toBe("New guide with different title");
      yield* stack.destroy();
      expect(
        yield* getPage("alchemy-pr-1578-wiki-replace", "Quick Start"),
      ).toBeUndefined();
    }),
  { timeout: 120_000 },
);
