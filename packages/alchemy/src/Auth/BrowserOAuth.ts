/**
 * Shared browser-OAuth ceremony for auth providers: open the authorization
 * URL, then race the provider's local callback listener against the branded
 * "waiting for browser" prompt (spinner + compact URL; Enter switches to
 * manual code entry, `o` opens the browser again, and `c` copies the URL).
 *
 * Built-in providers (Cloudflare, Planetscale) and custom stack-provided
 * auth providers should all route their browser flows through this so the
 * login UX stays uniform.
 */
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import * as CliKit from "../Cli/CliKit/index.ts";

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

export const browserOAuth = <A, E1, R1, E2, R2>(
  options: BrowserOAuthOptions<A, E1, R1, E2, R2>,
): Effect.Effect<
  A,
  E1 | E2 | CliKit.InteractionError,
  R1 | R2 | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ChildProcessSpawner>();
    const openFailed = yield* CliKit.openUrl(options.url).pipe(
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    );
    return yield* Effect.raceFirst(
      options.callback,
      (yield* CliKit.CliKit).prompt
        .awaitExternal({
          message: `${options.provider} authorization`,
          waitingLabel:
            options.waitingLabel ??
            "waiting for browser authorization (up to 5 minutes)…",
          url: options.url,
          openFailed,
          onOpen: () =>
            Effect.runPromiseWith(services)(CliKit.openUrl(options.url)),
          inputLabel: "Paste the authorization code or callback URL",
          validate: (value) =>
            value.trim().length > 0 ? undefined : "Paste a code or URL",
        })
        .pipe(Effect.flatMap(options.exchange)),
    );
  });
