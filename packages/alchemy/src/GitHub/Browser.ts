import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { Page } from "playwright-core";
import { browserProfileDir } from "../Auth/Paths.ts";
import { DEFAULT_PROFILE_NAME } from "../Auth/Profile.ts";
import * as Browser from "../Browser.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { githubWebOrigin } from "./BaseUrl.ts";
import { nextUnusedCode } from "./Totp.ts";

export const LOGIN_COMMAND = "alchemy provider github browser-login";

export interface GitHubBrowserCredentials {
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
  /** Base32 TOTP secret (RFC 6238, 30s/6 digits) of the authenticator app. */
  readonly totpSecret?: Redacted.Redacted<string>;
}

export interface GitHubBrowserOptions {
  /** Browser profile name under `~/.alchemy/browser`. @default the alchemy profile name */
  readonly profile?: string;
  /** Absolute browser profile directory; overrides `profile`. */
  readonly profileDir?: string;
  /** @default true */
  readonly headless?: boolean;
  /** GitHub host or API base URL. @default github.com */
  readonly baseUrl?: string;
  /** Sign in and confirm sudo mode unattended. */
  readonly credentials?: GitHubBrowserCredentials;
}

/** The browser profile holds no GitHub session (or it could not be restored). */
export class GitHubBrowserSignedOut extends Data.TaggedError(
  "GitHubBrowserSignedOut",
)<{
  readonly url: string;
  readonly profileDir: string;
  readonly detail?: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `${this.detail ?? `GitHub is not signed in on ${this.url}`} (browser profile: ${this.profileDir}). Run \`${LOGIN_COMMAND}\` to sign in.`;
  }
}

/** GitHub asked to confirm access (sudo mode) and nothing can answer it. */
export class GitHubBrowserSudoRequired extends Data.TaggedError(
  "GitHubBrowserSudoRequired",
)<{
  readonly url: string;
  readonly profileDir: string;
  readonly detail?: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub asked to confirm access (sudo mode) on ${this.url}${this.detail === undefined ? "" : ` and ${this.detail}`} (browser profile: ${this.profileDir}). Run \`${LOGIN_COMMAND}\` to confirm it in a window, or set GITHUB_BROWSER_PASSWORD or GITHUB_BROWSER_TOTP_SECRET for unattended runs.`;
  }
}

/** GitHub's secondary rate limit blocked the browser session. */
export class GitHubBrowserRateLimited extends Data.TaggedError(
  "GitHubBrowserRateLimited",
)<{
  readonly url: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub rate-limited the browser session on ${this.url} (secondary rate limit). Wait a few minutes and run again.`;
  }
}

export type GitHubBrowserError =
  | GitHubBrowserSignedOut
  | GitHubBrowserSudoRequired
  | GitHubBrowserRateLimited
  | Browser.BrowserError;

export const isGitHubBrowserError = (
  error: unknown,
): error is
  | GitHubBrowserSignedOut
  | GitHubBrowserSudoRequired
  | GitHubBrowserRateLimited =>
  error instanceof GitHubBrowserSignedOut ||
  error instanceof GitHubBrowserSudoRequired ||
  error instanceof GitHubBrowserRateLimited;

export class GitHubBrowser extends Context.Service<
  GitHubBrowser,
  {
    /** Open `url` in the signed-in session, pass every guard, then run `f`. */
    readonly page: <A>(
      url: string,
      f: (page: Page) => Promise<A>,
    ) => Effect.Effect<A, GitHubBrowserError>;
    /** Web origin, e.g. `https://github.com`. */
    readonly origin: string;
    readonly profileDir: string;
  }
>()("GitHub::Browser") {}

// github.com/login, /session, /sessions/two-factor/*, /sessions/verified-device
const SIGN_IN = {
  loginPath: /^\/(login|session)(\/|$)/,
  twoFactorPath: /^\/sessions\/two-factor(\/|$)/,
  deviceVerificationPath: /^\/sessions\/verified-device(\/|$)/,
  username: "#login_field",
  password: "#password",
  totp: "#app_totp",
  totpLink: 'a[href*="/sessions/two-factor/app"]',
  userLogin: 'meta[name="user-login"]',
} as const;

// github.com/sessions/sudo, also rendered inline on the protected page
const SUDO = {
  path: /^\/sessions\/sudo(\/|$)/,
  form: 'form[action$="/sessions/sudo"]',
  totp: "#app_totp",
  password: "#sudo_password",
  useTotp: "Use your authenticator app",
  usePassword: "Use your password",
} as const;

const RATE_LIMIT_TEXT = "exceeded a secondary rate limit";

interface Session {
  readonly url: string;
  readonly origin: string;
  readonly profileDir: string;
  readonly credentials: GitHubBrowserCredentials | undefined;
  readonly totpCode: () => Promise<string>;
}

const sessions = new WeakMap<Page, Session>();

const pathOf = (page: Page) => new URL(page.url()).pathname;

const onOrigin = (page: Page, origin: string) =>
  new URL(page.url()).origin === origin;

const currentUser = (page: Page) =>
  page.locator(SIGN_IN.userLogin).getAttribute("content");

const onSudoPrompt = async (page: Page) =>
  SUDO.path.test(pathOf(page)) || (await page.locator(SUDO.form).count()) > 0;

const submitForm = async (page: Page) => {
  const loaded = page.waitForEvent("load");
  await page.keyboard.press("Enter");
  await loaded;
};

const verifySignedIn = async (
  page: Page,
  session: Session,
  username: string,
) => {
  const user = await currentUser(page);
  if (user === null || user.toLowerCase() !== username.toLowerCase()) {
    throw new GitHubBrowserSignedOut({
      url: page.url(),
      profileDir: session.profileDir,
      detail: `Signing in as ${username} did not succeed (GitHub reports ${user === null ? "no session" : `user ${user}`})`,
    });
  }
};

const enterTwoFactorCode = async (page: Page, session: Session) => {
  if (session.credentials?.totpSecret === undefined) {
    throw new GitHubBrowserSignedOut({
      url: page.url(),
      profileDir: session.profileDir,
      detail:
        "GitHub asked for a two-factor code and no GITHUB_BROWSER_TOTP_SECRET is configured",
    });
  }
  const input = page.locator(SIGN_IN.totp);
  if (!(await input.isVisible())) {
    await page.locator(SIGN_IN.totpLink).first().click();
    await page.waitForLoadState();
  }
  await input.fill(await session.totpCode());
  await submitForm(page);
};

const signIn = async (
  page: Page,
  session: Session,
  credentials: GitHubBrowserCredentials,
) => {
  await page.locator(SIGN_IN.username).fill(credentials.username);
  await page
    .locator(SIGN_IN.password)
    .fill(Redacted.value(credentials.password));
  await submitForm(page);
  if (SIGN_IN.twoFactorPath.test(pathOf(page))) {
    await enterTwoFactorCode(page, session);
  }
  if (SIGN_IN.deviceVerificationPath.test(pathOf(page))) {
    throw deviceVerification(page, session);
  }
  await verifySignedIn(page, session, credentials.username);
  if (pathOf(page) === "/") {
    await page.goto(session.url);
    await page.waitForLoadState();
  }
};

const deviceVerification = (page: Page, session: Session) =>
  new GitHubBrowserSignedOut({
    url: page.url(),
    profileDir: session.profileDir,
    detail: `GitHub requires device verification (a code sent by email) for this browser profile on ${page.url()}`,
  });

const confirmSudo = async (
  page: Page,
  session: Session,
  credentials: GitHubBrowserCredentials,
) => {
  const url = page.url();
  const loaded = page.waitForEvent("load");
  if (credentials.totpSecret !== undefined) {
    const input = page.locator(SUDO.totp);
    if (!(await input.isVisible())) {
      await page.getByRole("button", { name: SUDO.useTotp }).click();
    }
    await input.fill(await session.totpCode());
  } else {
    const input = page.locator(SUDO.password);
    if (!(await input.isVisible())) {
      await page.getByRole("button", { name: SUDO.usePassword }).click();
    }
    await input.fill(Redacted.value(credentials.password));
  }
  await page.keyboard.press("Enter");
  await loaded;
  if (await onSudoPrompt(page)) {
    throw new GitHubBrowserSudoRequired({
      url,
      profileDir: session.profileDir,
      detail: "GitHub rejected the configured credentials",
    });
  }
};

/**
 * Run after every navigation: fails fast (with a typed error) on the
 * secondary rate limit, a sign-in redirect and the sudo prompt, signing in
 * or confirming sudo unattended when credentials are configured.
 */
export const guard = async (page: Page): Promise<void> => {
  const session = sessions.get(page);
  if (session === undefined) {
    throw new Error(
      "guard(page) was called on a page that GitHubBrowser.page did not open",
    );
  }
  await page.waitForLoadState();
  if ((await page.getByText(RATE_LIMIT_TEXT).count()) > 0) {
    throw new GitHubBrowserRateLimited({ url: page.url() });
  }
  if (!onOrigin(page, session.origin)) return;
  if (SIGN_IN.deviceVerificationPath.test(pathOf(page))) {
    throw deviceVerification(page, session);
  }
  if (SIGN_IN.loginPath.test(pathOf(page))) {
    if (session.credentials === undefined) {
      throw new GitHubBrowserSignedOut({
        url: page.url(),
        profileDir: session.profileDir,
      });
    }
    await signIn(page, session, session.credentials);
  }
  if (await onSudoPrompt(page)) {
    if (session.credentials === undefined) {
      throw new GitHubBrowserSudoRequired({
        url: page.url(),
        profileDir: session.profileDir,
      });
    }
    await confirmSudo(page, session, session.credentials);
  }
};

interface ResolvedOptions {
  readonly profileDir: string;
  readonly origin: string;
  readonly credentials: GitHubBrowserCredentials | undefined;
}

const resolveOptions = (
  options: GitHubBrowserOptions,
): Effect.Effect<ResolvedOptions> =>
  Effect.sync(() => ({
    profileDir:
      options.profileDir ??
      browserProfileDir(
        options.profile ?? process.env.ALCHEMY_PROFILE ?? DEFAULT_PROFILE_NAME,
      ),
    origin: githubWebOrigin(options.baseUrl),
    credentials: options.credentials,
  }));

const make = (resolved: ResolvedOptions) =>
  Effect.gen(function* () {
    const browser = yield* Browser.Browser;
    const totpSecret = resolved.credentials?.totpSecret;
    const totpCode = () =>
      totpSecret === undefined
        ? Promise.reject(new Error("No TOTP secret is configured"))
        : Effect.runPromise(nextUnusedCode(totpSecret));
    const page = <A>(url: string, f: (page: Page) => Promise<A>) =>
      browser
        .withPage(url, async (page) => {
          sessions.set(page, {
            url,
            origin: resolved.origin,
            profileDir: resolved.profileDir,
            credentials: resolved.credentials,
            totpCode,
          });
          await guard(page);
          return f(page);
        })
        .pipe(
          Effect.catchTag("BrowserAutomationFailed", (error) =>
            Effect.fail(
              isGitHubBrowserError(error.cause) ? error.cause : error,
            ),
          ),
        );
    return GitHubBrowser.of({
      page,
      origin: resolved.origin,
      profileDir: resolved.profileDir,
    });
  });

export const layer = (
  options: GitHubBrowserOptions = {},
): Layer.Layer<GitHubBrowser, never, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.map(resolveOptions(options), (resolved) =>
      Layer.effect(GitHubBrowser, make(resolved)).pipe(
        Layer.provide(
          Browser.layer({
            profileDir: resolved.profileDir,
            headless: options.headless,
          }),
        ),
      ),
    ),
  );

/**
 * Options from the environment: `GITHUB_BROWSER_USERNAME`,
 * `GITHUB_BROWSER_PASSWORD`, `GITHUB_BROWSER_TOTP_SECRET`,
 * `ALCHEMY_GITHUB_BROWSER_PROFILE` and `GITHUB_BROWSER_HEADLESS=0` to show
 * the window. Unset variables leave their option undefined.
 */
export const optionsFromEnv: Effect.Effect<GitHubBrowserOptions> = Effect.gen(
  function* () {
    const env = yield* Effect.sync(() => ({
      username: process.env.GITHUB_BROWSER_USERNAME,
      password: process.env.GITHUB_BROWSER_PASSWORD,
      totpSecret: process.env.GITHUB_BROWSER_TOTP_SECRET,
      profileDir: process.env.ALCHEMY_GITHUB_BROWSER_PROFILE,
      headless: process.env.GITHUB_BROWSER_HEADLESS,
    }));
    if ((env.username === undefined) !== (env.password === undefined)) {
      return yield* Effect.die(
        new Error(
          "GITHUB_BROWSER_USERNAME and GITHUB_BROWSER_PASSWORD must be set together",
        ),
      );
    }
    const credentials: GitHubBrowserCredentials | undefined =
      env.username === undefined || env.password === undefined
        ? undefined
        : {
            username: env.username,
            password: Redacted.make(env.password),
            totpSecret:
              env.totpSecret === undefined
                ? undefined
                : Redacted.make(env.totpSecret),
          };
    return {
      profileDir: env.profileDir,
      headless: env.headless === undefined ? undefined : env.headless !== "0",
      credentials,
    };
  },
);

/**
 * Configure from the environment (see {@link optionsFromEnv}); headless
 * unless `GITHUB_BROWSER_HEADLESS=0`. Explicit `overrides` win over the
 * environment.
 */
export const fromEnv = (
  overrides: GitHubBrowserOptions = {},
): Layer.Layer<GitHubBrowser, never, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.map(optionsFromEnv, (env) =>
      layer({ ...env, headless: env.headless ?? true, ...overrides }),
    ),
  );

const waitForHuman =
  (target: string, profileDir: string) =>
  async (page: Page): Promise<string> => {
    const targetPath = new URL(target).pathname;
    const ready = async () =>
      pathOf(page) === targetPath &&
      !(await onSudoPrompt(page)) &&
      (await currentUser(page)) !== null;
    while (!page.isClosed()) {
      if (await ready().catch(() => false)) {
        return (await currentUser(page)) ?? "";
      }
      await page.waitForTimeout(1000).catch(() => undefined);
    }
    throw new GitHubBrowserSignedOut({
      url: target,
      profileDir,
      detail: "The browser window was closed before the sign-in finished",
    });
  };

/**
 * Establish a signed-in session in the browser profile. Opens the new-app
 * settings page (which sits behind sudo mode) in a window and waits for a
 * human to sign in and confirm access; with `credentials` it signs in
 * unattended instead.
 */
export const login = (
  options: GitHubBrowserOptions = {},
): Effect.Effect<
  { readonly profileDir: string; readonly user: string },
  GitHubBrowserError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveOptions(options);
    const target = `${resolved.origin}/settings/apps/new`;
    const browser = Browser.layer({
      profileDir: resolved.profileDir,
      headless: options.headless ?? resolved.credentials !== undefined,
    });
    const user =
      resolved.credentials === undefined
        ? yield* Browser.Browser.use((b) =>
            b.withPage(target, waitForHuman(target, resolved.profileDir)),
          ).pipe(
            Effect.provide(browser),
            Effect.catchTag("BrowserAutomationFailed", (error) =>
              Effect.fail(
                isGitHubBrowserError(error.cause) ? error.cause : error,
              ),
            ),
          )
        : yield* GitHubBrowser.use((github) =>
            github.page(
              target,
              async (page) => (await currentUser(page)) ?? "",
            ),
          ).pipe(
            Effect.provide(
              Layer.effect(GitHubBrowser, make(resolved)).pipe(
                Layer.provide(browser),
              ),
            ),
          );
    return { profileDir: resolved.profileDir, user };
  });
