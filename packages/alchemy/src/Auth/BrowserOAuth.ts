/**
 * Shared browser-OAuth ceremony for auth providers: open the authorization
 * URL, then race the provider's local callback listener against the branded
 * "waiting for browser" prompt (spinner + URL; Enter switches to
 * manual code entry, `o` opens the browser again, and `c` copies the URL).
 *
 * {@link deviceOAuth} is the device-code (RFC 8628) counterpart.
 *
 * Built-in providers (Planetscale, Cloudflare) and custom stack-provided
 * auth providers should all route their browser flows through these so the
 * login UX stays uniform.
 */
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Interaction from "../Interaction.ts";
import { CallbackServerStartError, type DeviceAuthorization } from "./OAuthFlow.ts";

export interface BrowserOAuthOptions<A, E1, R1, E2, R2> {
  /** Display name, e.g. "Cloudflare" — used in the prompt title. */
  provider: string;
  /** The authorization URL the browser was pointed at. */
  url: string;
  /** Resolves when the local callback listener receives the redirect. */
  callback: Effect.Effect<A, E1, R1>;
  /** Exchanges a manually pasted code / callback URL for credentials. */
  exchange: (input: string) => Effect.Effect<A, E2, R2>;
  /** Spinner label. @default "waiting for browser authorization (up to 5 minutes)…" */
  waitingLabel?: string;
}

export const browserOAuth = Effect.fn(function* <A, E1, R1, E2, R2>(
  options: BrowserOAuthOptions<A, E1, R1, E2, R2>,
) {
  const services = yield* Effect.context<ChildProcessSpawner>();
  // This runner is invoked later by React's keyboard event boundary, not
  // while the surrounding Effect is executing.
  const runPromise = Effect.runPromiseWith(services);
  const openFailed = yield* Interaction.openUrl(options.url).pipe(
    Effect.as(false),
    Effect.orElseSucceed(() => true),
  );
  return yield* Effect.raceFirst(
    // A callback server that cannot start (e.g. the port is taken) must not
    // fail the race — warn and hang so manual code entry stays available.
    // Genuine OAuth failures delivered via the callback still fail fast.
    options.callback.pipe(
      Effect.catchIf(
        (e): e is E1 & CallbackServerStartError => e instanceof CallbackServerStartError,
        (e) =>
          Interaction.accessors.output
            .warning(`${e.message} — paste the authorization code instead.`)
            .pipe(Effect.andThen(Effect.never)),
      ),
    ),
    (yield* Interaction.Interaction).prompt
      .awaitExternal({
        message: `${options.provider} authorization`,
        waitingLabel:
          options.waitingLabel ?? "waiting for browser authorization (up to 5 minutes)…",
        url: options.url,
        openFailed,
        onOpen: () => runPromise(Interaction.openUrl(options.url)),
        inputLabel: "Paste the authorization code or callback URL",
        validate: (value) => (value.trim().length > 0 ? undefined : "Paste a code or URL"),
      })
      .pipe(Effect.flatMap(options.exchange)),
  );
});

export interface DeviceOAuthOptions<A, E, R> {
  /** Display name, e.g. "Cloudflare" — used in the prompt title. */
  provider: string;
  /** The pending device authorization to show the user. */
  authorization: DeviceAuthorization;
  /** Polls until the user approves; usually `client.deviceToken(authorization)`. */
  token: Effect.Effect<A, E, R>;
}

/**
 * Shared device-authorization (RFC 8628) ceremony: open the verification
 * URL, show the user code, and wait for the token poll. The prompt only
 * renders the URL/code and re-opens the browser; the poll always wins.
 */
export const deviceOAuth = Effect.fn(function* <A, E, R>(options: DeviceOAuthOptions<A, E, R>) {
  const services = yield* Effect.context<ChildProcessSpawner>();
  const url = options.authorization.verificationUriComplete;
  // Invoked later by React's keyboard event boundary.
  const runPromise = Effect.runPromiseWith(services);
  const openFailed = yield* Effect.isFailure(Interaction.openUrl(url));
  return yield* Effect.raceFirst(
    options.token,
    Interaction.accessors.prompt
      .awaitExternal({
        message: `${options.provider} authorization`,
        waitingLabel: "waiting for browser authorization (up to 5 minutes)…",
        url,
        code: options.authorization.userCode,
        openFailed,
        onOpen: () => runPromise(Interaction.openUrl(url)),
        allowManualInput: false,
      })
      .pipe(Effect.andThen(Effect.never)),
  );
});
