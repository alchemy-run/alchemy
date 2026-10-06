// Shared harness for the GitHub App live tests.
//
// GitHub has no API to register, install, delete or re-permission an app, so
// those steps are driven through the real GitHub UI by Playwright, using a
// dedicated Chrome profile signed in as an OWNER of the test org
// (GITHUB_APP_TEST_OWNER, default FD-Test-Org).
//
// The tests hold no credentials. Sign that profile in once, in a window:
//
//   bun test/GitHub/app-harness.ts login
//
// Test runs are always headless and reuse the saved session. A logged-out
// profile, or GitHub asking to confirm access (sudo mode), fails fast and
// names that command. GITHUB_APP_TEST_BROWSER_PROFILE moves the profile.
import * as GitHub from "@/GitHub/index.ts";
import * as Octokit from "@/GitHub/Octokit.ts";
import * as Interaction from "@/Interaction.ts";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { Octokit as RestOctokit } from "@octokit/rest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as os from "node:os";
import * as path from "node:path";

export const owner = process.env.GITHUB_APP_TEST_OWNER ?? "FD-Test-Org";
if (!/test/i.test(owner)) {
  throw new Error(
    `GITHUB_APP_TEST_OWNER must name a dedicated test org, got ${owner}`,
  );
}

// App names are global across GitHub and capped at 34 characters.
export const appPrefix = `${owner.toLowerCase()}-alc-`;
export const appName = (id: string) => {
  const name = `${appPrefix}${id}`;
  if (name.length > 34) throw new Error(`App name too long: ${name}`);
  return name;
};

export const fixtureRepos = [
  "alchemy-app-fixture-a",
  "alchemy-app-fixture-b",
] as const;

const profileDir =
  process.env.GITHUB_APP_TEST_BROWSER_PROFILE ??
  path.join(os.homedir(), ".cache", "alchemy-github-test-browser");

const relogin = `Run \`bun test/GitHub/app-harness.ts login\` and sign in as an owner of ${owner} (profile: ${profileDir}).`;

export class GitHubBrowserError extends Data.TaggedError("GitHubBrowserError")<{
  readonly message: string;
}> {}

// The typed failure, or the defect when the provider died: a die then shows
// up in the assertion diff instead of an opaque `undefined`.
export const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

export const appOctokit = (
  appId: number,
  privateKey: Redacted.Redacted<string>,
): RestOctokit => Octokit.appOctokit(appId, privateKey, undefined);

// 200 → the app exists, 404 → it does not. Uses the caller's (owner) token,
// which can see the org's private apps.
export const appExists = (octokit: RestOctokit, slug: string) =>
  Effect.tryPromise(async () => {
    try {
      await octokit.rest.apps.getBySlug({ app_slug: slug });
      return true;
    } catch (error: any) {
      if (error.status === 404) return false;
      throw error;
    }
  });

const launch = (headless: boolean) =>
  chromium.launchPersistentContext(profileDir, { channel: "chrome", headless });

const sessionLogin = (page: Page) =>
  page.locator('meta[name="user-login"]').getAttribute("content");

// One browser per test process; Playwright ends it when the process exits.
let context: Promise<BrowserContext> | undefined;

const browser = () =>
  (context ??= launch(true).then((ctx) => {
    ctx.setDefaultTimeout(10_000);
    return ctx;
  }));

const onLoginPage = (page: Page) => {
  const url = new URL(page.url());
  return (
    url.hostname === "github.com" &&
    /^\/(login|session)(\/|$)/.test(url.pathname)
  );
};

const onSudoPrompt = async (page: Page) =>
  new URL(page.url()).pathname.startsWith("/sessions/sudo") ||
  (await page.locator('form[action="/sessions/sudo"]').count()) > 0;

// Every navigation passes through here, so a page the automation cannot
// drive fails in seconds rather than at the action timeout.
const guard = async (page: Page) => {
  await page.waitForLoadState();
  if ((await page.getByText("exceeded a secondary rate limit").count()) > 0) {
    throw new GitHubBrowserError({
      message: `GitHub rate-limited the test browser on ${page.url()} (secondary rate limit). Wait a few minutes and run fewer browser tests at once.`,
    });
  }
  if (onLoginPage(page)) {
    throw new GitHubBrowserError({
      message: `GitHub redirected to ${new URL(page.url()).pathname}: the test browser is signed out. ${relogin}`,
    });
  }
  if (await onSudoPrompt(page)) {
    throw new GitHubBrowserError({
      message: `GitHub asked to confirm access (sudo mode) on ${page.url()}. ${relogin}`,
    });
  }
};

const withPage = <A>(url: string, f: (page: Page) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      const page = await (await browser()).newPage();
      try {
        await page.goto(url);
        await guard(page);
        return await f(page);
      } catch (error) {
        if (error instanceof GitHubBrowserError) throw error;
        const screenshot = path.join(
          os.tmpdir(),
          `alchemy-github-browser-${Date.now()}.png`,
        );
        await page
          .screenshot({ path: screenshot, fullPage: true })
          .catch(() => undefined);
        throw new GitHubBrowserError({
          message: `Browser automation failed at ${page.url()} (screenshot: ${screenshot}): ${String(error)}`,
        });
      } finally {
        await page.close();
      }
    },
    catch: (error) =>
      error instanceof GitHubBrowserError
        ? error
        : new GitHubBrowserError({
            message: `Browser automation failed on ${url}: ${String(error)}`,
          }),
  });

const orgSettings = (org: string) =>
  `https://github.com/organizations/${org}/settings`;

// GitHub's secondary rate limit rejects manifest submissions that follow
// each other within seconds; 30s apart was never rejected.
const manifestGap = 30_000;
let nextManifest = 0;
const manifestTurn = async () => {
  const wait = Math.max(nextManifest - Date.now(), 0);
  nextManifest = Date.now() + wait + manifestGap;
  await new Promise((resolve) => setTimeout(resolve, wait));
};

const registerFromManifest = async (page: Page) => {
  // The provider's localhost page auto-submits the manifest form to GitHub.
  await page.waitForURL((u) => u.hostname === "github.com");
  await guard(page);
  await page.getByRole("button", { name: /^Create GitHub App/ }).click();
  await guard(page);
  // GitHub redirects back to the provider's localhost callback.
  await page.waitForURL((u) => u.hostname !== "github.com");
};

const deleteApp = async (page: Page, slug: string) => {
  await page.getByRole("button", { name: "Delete GitHub App" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(slug);
  await dialog.getByRole("button", { name: /delete this GitHub App/i }).click();
  await guard(page);
  await page.waitForURL((u) => !u.pathname.includes(`/apps/${slug}`));
};

/** UI fix a human would make: raise one permission on the app registration. */
export const setAppPermission = (input: {
  readonly slug: string;
  /** Permission key as in the REST API, e.g. "issues". */
  readonly permission: string;
  readonly access: "none" | "read" | "write";
}) =>
  withPage(
    `${orgSettings(owner)}/apps/${input.slug}/permissions`,
    async (page) => {
      const item = page.locator(
        `#integration_permission_${input.permission}_${input.access}`,
      );
      // Each permission group is a collapsed <details>.
      await item.evaluate((element) => {
        for (
          let group = element.closest("details");
          group;
          group = group.parentElement?.closest("details") ?? null
        ) {
          group.open = true;
        }
      });
      const menu = page.locator('ul[role="menu"]', { has: item });
      await page
        .locator(`[id="${await menu.getAttribute("aria-labelledby")}"]`)
        .click();
      await item.click();
      await page.getByRole("button", { name: "Save changes" }).click();
      const confirm = page.getByRole("button", { name: /^Save/ }).last();
      if (await confirm.isVisible()) await confirm.click();
      await guard(page);
    },
  );

/** Out-of-band delete through the UI (also used by cleanup). */
export const deleteAppInUi = (slug: string, options?: { user?: boolean }) =>
  withPage(
    `${options?.user ? "https://github.com/settings" : orgSettings(owner)}/apps/${slug}/advanced`,
    (page) => deleteApp(page, slug),
  );

export const listTestAppsInUi = withPage(
  `${orgSettings(owner)}/apps`,
  async (page) => {
    const hrefs = await page
      .locator(`a[href^="/organizations/${owner}/settings/apps/"]`)
      .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
    return [
      ...new Set(
        hrefs
          .map((href) => href.split("/")[5] ?? "")
          .filter((slug) => slug.startsWith(appPrefix)),
      ),
    ];
  },
);

// Standing repos for selected-repository installs. Created on first use and
// never deleted: the default token lacks `delete_repo`.
export const ensureFixtureRepos = (octokit: RestOctokit) =>
  Effect.forEach(fixtureRepos, (name) =>
    Effect.tryPromise(async () => {
      try {
        await octokit.rest.repos.get({ owner, repo: name });
      } catch (error: any) {
        if (error.status !== 404) throw error;
        await octokit.rest.repos.createInOrg({
          org: owner,
          name,
          private: true,
          auto_init: true,
        });
      }
    }),
  );

export const deleteAppIfExists = (octokit: RestOctokit, slug: string) =>
  Effect.gen(function* () {
    if (yield* appExists(octokit, slug)) yield* deleteAppInUi(slug);
  });

export interface Autopilot {
  /** Every URL the provider asked to open, in order. */
  readonly launched: string[];
  /** Every `awaitExternal` prompt the provider raised (its URL). */
  readonly prompts: Array<string | undefined>;
  /**
   * Run `effect` as if a human sat at the terminal: prompts wait instead of
   * failing, and every URL the provider opens is
   * handled by the routed browser automation. An automation failure fails the
   * effect immediately instead of leaving the provider waiting.
   */
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitHubBrowserError, R | Interaction.Interaction>;
}

export const autopilot = (
  options: {
    /** A human who never acts: URLs are recorded but nothing is clicked. */
    readonly idle?: boolean;
  } = {},
): Autopilot => {
  const launched: string[] = [];
  const prompts: Array<string | undefined> = [];
  const failure = Deferred.makeUnsafe<never, GitHubBrowserError>();

  const route = (url: string) => {
    const { hostname, pathname } = new URL(url);
    const drive = (f: (page: Page) => Promise<void>) =>
      withPage(url, f).pipe(
        Effect.catch((error) =>
          Effect.sync(() => Deferred.doneUnsafe(failure, Effect.fail(error))),
        ),
        Effect.runPromise,
      );
    const unrouted = (message: string) =>
      Deferred.doneUnsafe(
        failure,
        Effect.fail(new GitHubBrowserError({ message })),
      );
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return manifestTurn().then(() => drive(registerFromManifest));
    }
    const advanced = pathname.match(/\/settings\/apps\/([^/]+)\/advanced$/);
    if (advanced) return drive((page) => deleteApp(page, advanced[1]!));
    return unrouted(
      `Provider opened ${url}, which the autopilot has no route for`,
    );
  };

  const launcher = (url: string) =>
    Effect.sync(() => {
      launched.push(url);
      if (!options.idle) void route(url);
    });

  return {
    launched,
    prompts,
    run: (effect) =>
      Effect.flatMap(Interaction.Interaction, (base) =>
        Effect.raceFirst(
          effect.pipe(
            Effect.provideService(Interaction.BrowserLauncher, launcher),
            Effect.provideService(Interaction.Interaction, {
              ...base,
              prompt: {
                ...base.prompt,
                awaitExternal: (prompt: Interaction.AwaitExternalOptions) => {
                  prompts.push(prompt.url);
                  return Effect.never;
                },
              },
            }),
          ),
          Deferred.await(failure),
        ),
      ),
  };
};

// Bounded human-wait used by attended test runs: long enough for the
// automation, short enough that a stuck flow fails inside the test timeout.
export const withManualStepTimeout =
  (timeout: Duration.Input) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, GitHub.ManualStepTimeout, timeout);

// The one headed window: a human signs in and confirms access. The new-app
// page is behind sudo mode, so reaching it leaves the session ready for tests.
const login = async () => {
  const target = `${orgSettings(owner)}/apps/new`;
  const ctx = await launch(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  console.log(
    `Sign in as an owner of ${owner} and confirm access if GitHub asks. Closing the window cancels.`,
  );
  const ready = async () =>
    new URL(page.url()).pathname === new URL(target).pathname &&
    !(await onSudoPrompt(page)) &&
    Boolean(await sessionLogin(page));
  await page.goto(target).catch(() => undefined);
  // A check that lands mid-navigation throws; the next round retries it.
  while (!page.isClosed() && !(await ready().catch(() => false))) {
    await page.waitForTimeout(1000).catch(() => undefined);
  }
  if (page.isClosed()) {
    console.error("The window was closed before the sign-in finished.");
    process.exitCode = 1;
  } else {
    console.log(`Signed in. Profile: ${profileDir}`);
  }
  await ctx.close().catch(() => undefined);
};

if (import.meta.main && process.argv[2] === "login") void login();
