import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import type { BrowserContext, Page } from "playwright-core";
import { UserFacingError } from "./UserFacingError.ts";

/** Playwright or a usable Chromium could not be loaded or launched. */
export class BrowserUnavailable extends Data.TaggedError("BrowserUnavailable")<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** A page driver threw; a full-page screenshot was captured when possible. */
export class BrowserAutomationFailed extends Data.TaggedError(
  "BrowserAutomationFailed",
)<{
  readonly url: string;
  readonly screenshot: string | undefined;
  readonly cause: unknown;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    const detail =
      this.cause instanceof Error ? this.cause.message : String(this.cause);
    const screenshot =
      this.screenshot === undefined
        ? ""
        : ` Screenshot saved to ${this.screenshot}.`;
    return `Browser automation failed at ${this.url}: ${detail}.${screenshot}`;
  }
}

export type BrowserError = BrowserUnavailable | BrowserAutomationFailed;

export interface BrowserOptions {
  readonly profileDir: string;
  /** @default true */
  readonly headless?: boolean;
  /** @default "chrome" */
  readonly channel?: "chrome" | "chromium" | "msedge";
  /** @default 30 seconds */
  readonly defaultTimeout?: Duration.Input;
}

export class Browser extends Context.Service<
  Browser,
  {
    readonly withPage: <A>(
      url: string,
      f: (page: Page) => Promise<A>,
    ) => Effect.Effect<A, BrowserError>;
    readonly profileDir: string;
  }
>()("Alchemy::Browser") {}

const INSTALL_HINT =
  "Install the optional peer dependency with `pnpm add -D playwright-core` and make sure Google Chrome is installed.";

const isBrowserError = (cause: unknown): cause is BrowserError =>
  cause instanceof BrowserUnavailable ||
  cause instanceof BrowserAutomationFailed;

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const launchFailure = (channel: string, cause: unknown): BrowserUnavailable => {
  const detail = describeCause(cause);
  return new BrowserUnavailable({
    message: /executable|not found|is not installed/i.test(detail)
      ? `Could not launch the '${channel}' browser: ${detail}\n${INSTALL_HINT}`
      : `Could not launch the '${channel}' browser: ${detail}`,
  });
};

const launchContext = (
  options: BrowserOptions,
): Effect.Effect<
  BrowserContext,
  BrowserUnavailable,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = options.channel ?? "chrome";
    const headless = options.headless ?? true;
    yield* fs
      .makeDirectory(options.profileDir, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(fs.chmod(options.profileDir, 0o700)),
        Effect.mapError(
          (cause) =>
            new BrowserUnavailable({
              message: `Could not create the browser profile directory '${options.profileDir}': ${cause.message}`,
            }),
        ),
      );
    const playwright = yield* Effect.tryPromise({
      try: () => import("playwright-core"),
      catch: (cause) =>
        new BrowserUnavailable({
          message: `Failed to load 'playwright-core': ${describeCause(cause)}\n${INSTALL_HINT}`,
        }),
    });
    const context = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          playwright.chromium.launchPersistentContext(options.profileDir, {
            channel,
            headless,
          }),
        catch: (cause) => launchFailure(channel, cause),
      }),
      (context) => Effect.ignore(Effect.tryPromise(() => context.close())),
    );
    yield* Effect.sync(() =>
      context.setDefaultTimeout(
        Duration.toMillis(options.defaultTimeout ?? "30 seconds"),
      ),
    );
    return context;
  });

export const layer = (
  options: BrowserOptions,
): Layer.Layer<Browser, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scope = yield* Effect.scope;
      const context = yield* Effect.cached(
        launchContext(options).pipe(
          Scope.provide(scope),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      );

      const screenshotOf = (page: Page): Effect.Effect<string | undefined> =>
        fs.makeTempDirectory({ prefix: "alchemy-browser-" }).pipe(
          Effect.flatMap((dir) => {
            const file = path.join(dir, "failure.png");
            return Effect.tryPromise(() =>
              page.screenshot({ path: file, fullPage: true }),
            ).pipe(Effect.as(file));
          }),
          Effect.orElseSucceed(() => undefined),
        );

      const withPage = <A>(
        url: string,
        f: (page: Page) => Promise<A>,
      ): Effect.Effect<A, BrowserError> =>
        Effect.gen(function* () {
          const browser = yield* context;
          const page = yield* Effect.tryPromise({
            try: () => browser.newPage(),
            catch: (cause) =>
              new BrowserAutomationFailed({
                url,
                screenshot: undefined,
                cause,
              }),
          });
          return yield* Effect.tryPromise({
            try: async () => {
              await page.goto(url);
              await page.waitForLoadState();
              return await f(page);
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              isBrowserError(cause)
                ? Effect.fail(cause)
                : screenshotOf(page).pipe(
                    Effect.flatMap((screenshot) =>
                      Effect.fail(
                        new BrowserAutomationFailed({ url, screenshot, cause }),
                      ),
                    ),
                  ),
            ),
            Effect.ensuring(
              Effect.ignore(Effect.tryPromise(() => page.close())),
            ),
          );
        });

      return Browser.of({ withPage, profileDir: options.profileDir });
    }),
  );
