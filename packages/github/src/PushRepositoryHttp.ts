import * as Gateway from "alchemy/Gateway";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { PersonalAccessToken } from "./PersonalAccessToken.ts";
import { PushRepository, type GitRemote } from "./PushRepository.ts";
import type { Repository } from "./Repository.ts";

/** The `GIT_CONFIG_*` variables that send `headers` to `url` only. */
const gitEnv = (url: string, headers: Readonly<Record<string, string>>) => {
  const entries = Object.entries(headers);
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([name, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, `http.${url}.extraHeader`],
        [`GIT_CONFIG_VALUE_${index}`, `${name}: ${value}`],
      ]),
    ),
    // Never fall back to asking for a password.
    GIT_TERMINAL_PROMPT: "0",
  };
};

/**
 * The token-backed implementation of {@link PushRepository}. Works on any
 * host: the host's `GitHub.PersonalAccessToken` authenticates git over HTTPS.
 *
 * ### Provide the layer
 * **Example:** In a sandbox with a gateway
 * ```typescript
 * Effect.gen(function* () {
 *   const repo = yield* GitHub.PushRepository(MyRepo);
 *   // ...
 * }).pipe(
 *   Effect.provide(
 *     GitHub.PushRepositoryHttp.pipe(Layer.provide(Cloudflare.Workers.SandboxGateway)),
 *   ),
 * )
 * ```
 *
 * @layer
 * @product Repository
 * @provides GitHub.PushRepository
 */
export const PushRepositoryHttp = Layer.effect(
  PushRepository,
  Effect.gen(function* () {
    const Token = yield* PersonalAccessToken;
    const self = yield* Self;
    return Effect.fn("GitHub.PushRepository")(function* (repo: Repository) {
      const token = yield* (yield* Token(`${self.LogicalId}GitHubToken`)).value;
      const cloneUrl = yield* repo.cloneUrl;
      const upstream = Effect.all([cloneUrl, token]).pipe(
        Effect.map(([url, secret]) => ({
          url: url.replace(/\/+$/, ""),
          headers: {
            // GitHub's git endpoints take a token as a basic-auth password.
            authorization: `Basic ${btoa(`x-access-token:${Redacted.value(secret)}`)}`,
          },
        })),
      );
      return {
        remote: Gateway.proxy(`GitHub.PushRepository(${repo.LogicalId})`, upstream).pipe(
          Effect.map(({ url, headers }): GitRemote => ({ url, env: gitEnv(url, headers) })),
        ),
      };
    });
  }),
);
