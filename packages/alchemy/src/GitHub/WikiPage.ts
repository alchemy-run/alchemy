import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { dedent } from "../Util/dedent.ts";
import { gitHubBaseUrlChanged, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface WikiPageProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Page title (e.g. `Home`, `Getting Started`). The title is the page's
   * identity — changing it replaces the page (creates a new page and deletes
   * the old one if opted in via `allowDelete`).
   */
  title: string;

  /**
   * Page content (supports GitHub Markdown, AsciiDoc, MediaWiki, and more
   * depending on the file extension derived from `format`).
   *
   * The content is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  content: string;

  /**
   * Commit message for creating or updating the page.
   * @default "Update {title}"
   */
  message?: string;

  /**
   * Page format/markup language. The format is appended to the page name as
   * an extension (e.g. `markdown` → `Page.md`, `asciidoc` → `Page.asciidoc`).
   * @default "markdown"
   */
  format?: "markdown" | "asciidoc" | "mediawiki" | "org" | "pod" | "rdoc" | "rest" | "textile";

  /**
   * Whether to allow deletion of the page when the resource is destroyed.
   * By default, wiki pages are never deleted to preserve documentation history.
   * @default false
   */
  allowDelete?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface WikiPage extends Resource<
  "GitHub.WikiPage",
  WikiPageProps,
  {
    /**
     * The page title.
     */
    title: string;

    /**
     * The page name in URL form (e.g. `Home`, `Getting-Started`).
     */
    pageName: string;

    /**
     * URL to view the page in a browser.
     */
    htmlUrl: string;

    /**
     * SHA hash of the current page revision.
     */
    sha: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub wiki page.
 *
 * `WikiPage` manages the lifecycle of a page in a repository's wiki. Wiki
 * pages are created on first deploy and updated in place on subsequent
 * deploys when the `content` changes. By default, pages are never deleted to
 * preserve documentation history — set `allowDelete: true` to opt in.
 *
 * The repository's wiki must be enabled (`hasWiki: true` on the Repository
 * resource). Wiki pages are version-controlled: each update is a Git commit.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 * ### Creating Wiki Pages
 * **Example:** Basic Wiki Page
 * ```typescript
 * const home = yield* GitHub.WikiPage("home", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Home",
 *   content: "Welcome to the wiki!",
 * });
 * ```
 *
 * **Example:** Formatted Wiki Page
 * ```typescript
 * yield* GitHub.WikiPage("getting-started", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Getting Started",
 *   content: `
 *     # Getting Started
 *
 *     Install the package:
 *
 *     \`\`\`bash
 *     npm install my-package
 *     \`\`\`
 *   `,
 *   format: "markdown",
 *   message: "Add getting started guide",
 * });
 * ```
 *
 * ### Updating Wiki Pages
 * Deploy with the same logical ID and a different `content` to update the
 * existing page in place rather than creating a new one.
 *
 * **Example:** Update Page Content
 * ```typescript
 * yield* GitHub.WikiPage("api-docs", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "API Documentation",
 *   content: "Updated API documentation content",
 * });
 * ```
 *
 * ### Alternative Formats
 * **Example:** AsciiDoc Page
 * ```typescript
 * yield* GitHub.WikiPage("architecture", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Architecture",
 *   content: `
 *     = System Architecture
 *
 *     == Overview
 *
 *     The system is built with...
 *   `,
 *   format: "asciidoc",
 * });
 * ```
 *
 * ### Deleting Wiki Pages
 * **Example:** Allow Page Deletion
 * ```typescript
 * const temp = yield* GitHub.WikiPage("temp-page", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Temporary Page",
 *   content: "This page can be deleted",
 *   allowDelete: true,
 * });
 * ```
 *
 * ### Wiring with Other Resources
 * **Example:** Create Wiki Pages for a Repository
 * ```typescript
 * const repo = yield* GitHub.Repository("docs", {
 *   owner: "my-org",
 *   name: "docs",
 *   hasWiki: true,
 *   autoInit: true,
 * });
 *
 * yield* GitHub.WikiPage("home", {
 *   owner: repo.owner!,
 *   repository: repo.name!,
 *   title: "Home",
 *   content: "Welcome to the documentation wiki!",
 * });
 * ```
 *
 * @resource
 */
export const WikiPage = Resource<WikiPage>("GitHub.WikiPage");

export const WikiPageProvider = () =>
  Provider.succeed(WikiPage, {
    stables: ["title", "pageName"],

    // Non-listable: GitHub's wiki pages API doesn't provide a list endpoint
    // for enumerating all pages across repositories. There's only a list
    // endpoint per repository, and with no ambient scope to enumerate from,
    // this collapses to the empty list.
    list: () => Effect.succeed([]),

    // A wiki page belongs to (host, owner, repository, title) — changing any
    // of these replaces the resource.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.title !== olds.title ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const octokit = yield* octokitFor(news.baseUrl);
      const content = dedent(news.content);
      const message = news.message ?? `Update ${news.title}`;
      const format = news.format ?? "markdown";

      // Convert title to page name (GitHub's URL-safe form)
      const pageName = news.title.replace(/\s+/g, "-");

      // Observe — probe for the existing page
      const observed = yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.request(
              "GET /repos/{owner}/{repo}/pages/{page_name}",
              {
                owner: news.owner,
                repo: news.repository,
                page_name: pageName,
              },
            );
            return data;
          } catch (error: any) {
            if (error.status === 404) return undefined;
            throw error;
          }
        },
        catch: (e) => e as Error,
      });

      // Ensure or Sync — GitHub's wiki API uses PUT for both create and update
      const { data } = yield* Effect.tryPromise({
        try: () =>
          octokit.request("PUT /repos/{owner}/{repo}/pages/{page_name}", {
            owner: news.owner,
            repo: news.repository,
            page_name: pageName,
            title: news.title,
            content,
            format,
            message,
            // The sha is only required for updates (to prevent conflicts)
            ...(observed !== undefined ? { sha: observed.sha } : {}),
          }),
        catch: (e) => e as Error,
      });

      return {
        title: data.title,
        pageName: data.name,
        htmlUrl: data.html_url,
        sha: data.sha,
      };
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (!olds.allowDelete) {
        return;
      }

      const octokit = yield* octokitFor(olds.baseUrl);
      const pageName = olds.title.replace(/\s+/g, "-");

      yield* Effect.tryPromise(async () => {
        try {
          await octokit.request("DELETE /repos/{owner}/{repo}/pages/{page_name}", {
            owner: olds.owner,
            repo: olds.repository,
            page_name: pageName,
            message: `Delete ${olds.title}`,
          });
        } catch (error: any) {
          if (error.status !== 404) {
            throw error;
          }
        }
      });
    }),
  });
