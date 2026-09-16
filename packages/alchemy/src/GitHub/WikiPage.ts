import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";
import {
  deleteWikiPage,
  readWikiPage,
  syncWikiPage,
  wikiRepository,
} from "./WikiPageGit.ts";

export {
  InvalidWikiPage,
  WikiGitError,
  WikiRepositoryUnavailable,
} from "./WikiPageGit.ts";

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
   * Page title (e.g. `Home`, `Getting Started`). Whitespace becomes hyphens
   * in the page name. Changing that name replaces the page (creates a new
   * page and deletes the old one if opted in via `allowDelete`).
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
  format?:
    | "markdown"
    | "asciidoc"
    | "mediawiki"
    | "org"
    | "pod"
    | "rdoc"
    | "rest"
    | "textile";

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
   * different GitHub instance is a different physical resource. Authenticated
   * wiki Git operations require HTTPS.
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
 * resource) and initialized by creating its first page in the GitHub web UI.
 * Enabling the wiki or setting `autoInit` on the repository does not initialize
 * the separate wiki Git repository. An inaccessible or uninitialized wiki
 * produces `WikiRepositoryUnavailable` with setup instructions.
 *
 * Git must be installed on the deployment machine. Pages are managed through
 * the wiki's Git repository, not the GitHub REST API. Each content or format
 * change creates a commit; unchanged pages do not. Concurrent pushes are
 * retried against a fresh checkout without force-pushing. Deletion removes the
 * current page file, not its Git history. Authentication uses a transient
 * process-environment header; tokens are not stored in clone URLs or Git config.
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
 * Deploy the repository first and create its first wiki page in the GitHub
 * web UI before adding `WikiPage` to the stack.
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const repo = yield* GitHub.Repository("docs", {
 *   owner: "my-org",
 *   name: "docs",
 *   hasWiki: true,
 *   autoInit: true,
 * });
 *
 * yield* GitHub.WikiPage("home", {
 *   owner: repo.owner!,
 *   repository: Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!),
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
    stables: ["pageName"],

    // Wiki pages have no account-wide enumeration API.
    list: () => Effect.succeed([]),

    // Replacement must not delete the successor when titles normalize identically.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.title.replace(/\s+/g, "-") !== olds.title.replace(/\s+/g, "-") ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    read: Effect.fn(function* ({ olds }) {
      return yield* readWikiPage(yield* wikiRepository(olds), olds);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      return yield* syncWikiPage(yield* wikiRepository(news), news);
    }),

    delete: Effect.fn(function* ({ olds }) {
      if (!olds.allowDelete) return;
      yield* deleteWikiPage(yield* wikiRepository(olds), olds);
    }),
  });
