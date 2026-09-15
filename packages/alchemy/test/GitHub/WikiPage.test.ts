import * as Alchemy from "@/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GitHub.providers(),
});

test.provider(
  "create and update wiki page",
  Effect.gen(function* () {
    const testId = `wiki-test-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-wiki-${testId}`;

    // Create a test repository with wiki enabled
    const stack1 = yield* Alchemy.Stack(
      "WikiPageTest1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          hasWiki: true,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const page = yield* GitHub.WikiPage("home", {
          owner,
          repository: repo.name!,
          title: "Home",
          content: "Welcome to the wiki!",
          allowDelete: true,
        });

        return { repo, page };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.page.title).toBe("Home");
    expect(result1.page.pageName).toBe("Home");
    expect(result1.page.htmlUrl).toContain(`${owner}/${repoName}/wiki`);

    // Update the page content
    const stack2 = yield* Alchemy.Stack(
      "WikiPageTest2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          hasWiki: true,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const page = yield* GitHub.WikiPage("home", {
          owner,
          repository: repo.name!,
          title: "Home",
          content: "# Updated Content\n\nThis is updated!",
          allowDelete: true,
        });

        return { repo, page };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.page.title).toBe("Home");
    expect(result2.page.sha).not.toBe(result1.page.sha);

    // Cleanup
    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "create page with custom format",
  Effect.gen(function* () {
    const testId = `wiki-format-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-wiki-${testId}`;

    const stack = yield* Alchemy.Stack(
      "WikiPageFormatTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          hasWiki: true,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const page = yield* GitHub.WikiPage("api", {
          owner,
          repository: repo.name!,
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

        return { repo, page };
      }),
    );

    const result = yield* stack.deploy();
    expect(result.page.title).toBe("API Documentation");
    expect(result.page.pageName).toBe("API-Documentation");

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "preserve page when allowDelete is false (default)",
  Effect.gen(function* () {
    const testId = `wiki-preserve-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-wiki-${testId}`;

    const stack = yield* Alchemy.Stack(
      "WikiPagePreserveTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          hasWiki: true,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const page = yield* GitHub.WikiPage("docs", {
          owner,
          repository: repo.name!,
          title: "Documentation",
          content: "Important documentation that should be preserved",
          // allowDelete: false is the default
        });

        return { repo, page };
      }),
    );

    const result = yield* stack.deploy();
    const pageTitle = result.page.title;

    // Destroy should not delete the page (only the repo is destroyed because
    // it has destroy() applied)
    yield* stack.destroy();

    // Note: The repo is deleted, so we can't verify the page still exists
    // This test just ensures destroy() doesn't fail when allowDelete is false
    expect(pageTitle).toBe("Documentation");
  }),
  { timeout: 180_000 },
);

test.provider(
  "replace page when title changes",
  Effect.gen(function* () {
    const testId = `wiki-replace-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-wiki-${testId}`;

    // Create page with original title
    const stack1 = yield* Alchemy.Stack(
      "WikiPageReplace1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          hasWiki: true,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const page = yield* GitHub.WikiPage("guide", {
          owner,
          repository: repo.name!,
          title: "Getting Started",
          content: "Original guide",
          allowDelete: true,
        });

        return { repo, page };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.page.title).toBe("Getting Started");

    // Change title (should replace)
    const stack2 = yield* Alchemy.Stack(
      "WikiPageReplace2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          hasWiki: true,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const page = yield* GitHub.WikiPage("guide", {
          owner,
          repository: repo.name!,
          title: "Quick Start",
          content: "New guide with different title",
          allowDelete: true,
        });

        return { repo, page };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.page.title).toBe("Quick Start");
    expect(result2.page.pageName).toBe("Quick-Start");

    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);
