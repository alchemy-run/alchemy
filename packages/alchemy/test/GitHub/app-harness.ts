// Shared harness for the GitHub App / AppInstallation live tests.
//
// GitHub has no API to register, install, delete or re-permission an app, so
// those steps are driven through the real GitHub UI by the GitHub.Browser
// session (src/GitHub/Browser.ts + WebFlows.ts), using a dedicated Chrome
// profile signed in as an OWNER of the test org (GITHUB_APP_TEST_OWNER,
// default FD-Test-Org).
//
// Sign that profile in once, in a window:
//
//   bun test/GitHub/app-harness.ts login
//
// or set GITHUB_BROWSER_USERNAME / GITHUB_BROWSER_PASSWORD /
// GITHUB_BROWSER_TOTP_SECRET so sign-in and sudo confirmation run unattended.
// Test runs are always headless and reuse the saved session. A logged-out
// profile, or GitHub asking to confirm access (sudo mode), fails fast with a
// typed GitHubBrowserError. GITHUB_APP_TEST_BROWSER_PROFILE moves the profile.
import * as GitHub from "@/GitHub/index.ts";
import * as Octokit from "@/GitHub/Octokit.ts";
import * as Interaction from "@/Interaction.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Octokit as RestOctokit } from "@octokit/rest";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as os from "node:os";
import * as path from "node:path";

export type { GitHubBrowserError } from "@/GitHub/Browser.ts";

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

export const profileDir =
  process.env.GITHUB_APP_TEST_BROWSER_PROFILE ??
  path.join(os.homedir(), ".cache", "alchemy-github-test-browser");

// The typed failure, or the defect when the provider died: a die then shows
// up in the assertion diff instead of an opaque `undefined`.
export const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

export const appOctokit = (
  appId: number,
  privateKey: Redacted.Redacted<string>,
): RestOctokit => Octokit.appOctokit(appId, privateKey, undefined);

export const installationOctokit = (
  appId: number,
  privateKey: Redacted.Redacted<string>,
  installationId: number,
): Effect.Effect<RestOctokit, Cause.UnknownError> =>
  Effect.tryPromise(async () => {
    const { data } = await appOctokit(
      appId,
      privateKey,
    ).rest.apps.createInstallationAccessToken({
      installation_id: installationId,
    });
    return new RestOctokit({ auth: data.token });
  });

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

// One browser session per test process, built on first use into a scope
// that never closes; Playwright ends Chrome when the process exits.
const browserScope = Scope.makeUnsafe();
const sharedBrowser = Effect.runSync(
  Effect.cached(
    Layer.build(GitHub.Browser.fromEnv({ profileDir, headless: true })).pipe(
      Scope.provide(browserScope),
      Effect.provide(NodeServices.layer),
    ),
  ),
);

export const browserLayer: Layer.Layer<GitHub.GitHubBrowser> =
  Layer.effectContext(sharedBrowser);

const orgSettings = (org: string) =>
  `https://github.com/organizations/${org}/settings`;

/** UI step an installation owner takes after the app raised permissions. */
export const acceptPermissionsInUi = (reviewUrl: string) =>
  GitHub.WebFlows.acceptInstallationPermissions({ reviewUrl }).pipe(
    Effect.provide(browserLayer),
  );

/** UI fix a human would make: raise one permission on the app registration. */
export const setAppPermission = (input: {
  readonly slug: string;
  /** Permission key as in the REST API, e.g. "issues". */
  readonly permission: string;
  readonly access: GitHub.WebFlows.PermissionAccess;
}) =>
  GitHub.WebFlows.updateAppPermissions({
    permissionsUrl: `${orgSettings(owner)}/apps/${input.slug}/permissions`,
    permissions: { [input.permission]: input.access },
  }).pipe(Effect.provide(browserLayer));

/** Out-of-band delete through the UI (also used by cleanup). */
export const deleteAppInUi = (slug: string, options?: { user?: boolean }) =>
  GitHub.WebFlows.deleteApp({
    advancedUrl: `${options?.user ? "https://github.com/settings" : orgSettings(owner)}/apps/${slug}/advanced`,
    slug,
  }).pipe(Effect.provide(browserLayer));

export const listTestAppsInUi = GitHub.GitHubBrowser.use((browser) =>
  browser.page(`${orgSettings(owner)}/apps`, async (page) => {
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
  }),
).pipe(Effect.provide(browserLayer));

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

export interface InstallChoice {
  readonly account: string;
  /** Omit to install on all repositories. */
  readonly repositories?: ReadonlyArray<string>;
}

export interface Autopilot {
  /**
   * Every URL opened for the provider, in order: the pages the browser
   * session drove (`GitHubBrowser.page`) and, on the human path, the URLs
   * handed to the browser launcher.
   */
  readonly launched: string[];
  /** Every `awaitExternal` prompt the provider raised (its URL). */
  readonly prompts: Array<string | undefined>;
  /**
   * Run `effect` with the test browser session in context, so every manual
   * step and UI-only drift repair is driven unattended; prompts wait instead
   * of failing. An automation failure fails the effect with its typed error.
   */
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    E | GitHub.GitHubBrowserError,
    R | Interaction.Interaction
  >;
}

const recordingBrowser = (launched: string[]) =>
  Layer.effect(
    GitHub.GitHubBrowser,
    Effect.map(GitHub.GitHubBrowser, (browser) =>
      GitHub.GitHubBrowser.of({
        ...browser,
        page: (url, f) =>
          Effect.suspend(() => {
            launched.push(url);
            return browser.page(url, f);
          }),
      }),
    ),
  ).pipe(Layer.provide(browserLayer));

export const autopilot = (
  options: {
    /** Unused: the provider passes account, selection and repositories itself. */
    readonly install?: InstallChoice;
    /** A human who never acts: no browser session, URLs are recorded only. */
    readonly idle?: boolean;
  } = {},
): Autopilot => {
  const launched: string[] = [];
  const prompts: Array<string | undefined> = [];

  const launcher = (url: string) =>
    Effect.sync(() => {
      launched.push(url);
    });

  return {
    launched,
    prompts,
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const driven: Effect.Effect<A, E, R> = options.idle
        ? effect
        : Effect.provide(effect, recordingBrowser(launched));
      return Effect.flatMap(Interaction.Interaction, (base) =>
        driven.pipe(
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
      );
    },
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
const login = GitHub.Browser.login({ profileDir, headless: false }).pipe(
  Effect.provide(NodeServices.layer),
);

if (import.meta.main && process.argv[2] === "login") {
  console.log(
    `Sign in as an owner of ${owner} and confirm access if GitHub asks. Closing the window cancels.`,
  );
  void Effect.runPromiseExit(login).then((exit) => {
    if (Exit.isFailure(exit)) {
      console.error(String(Cause.squash(exit.cause)));
      process.exitCode = 1;
      return;
    }
    console.log(`Signed in as ${exit.value.user}. Profile: ${profileDir}`);
  });
}
