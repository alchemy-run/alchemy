import type { SlackOpContext } from "@distilled.cloud/slack";
import { Credentials } from "@distilled.cloud/slack/Credentials";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { BotToken } from "./BotToken.ts";
import type { Channel } from "./Channel.ts";
import { tokenConfig } from "./Credentials.ts";

/**
 * Shared scaffolding for the `Slack.*Http` binding layers.
 *
 * Slack issues no workload identity and has no API to mint a scoped token:
 * a bot token exists only after a person installs the app, and it carries all
 * of the app's scopes. So each host captures one {@link BotToken} (the
 * profile's bot by default), shared by every Slack binding on it, and binds
 * its value into the host as a secret. A binding can only narrow what it
 * *calls* — a channel binding always targets its channel — not what the
 * token may do.
 *
 * NOT exported from `index.ts`.
 */

/** Where a client's calls authenticate. */
interface TokenSource {
  readonly token: Effect.Effect<Redacted.Redacted<string>>;
  readonly apiBaseUrl: Effect.Effect<string>;
}

/** Capture the host's bot token and bind it (and its API URL) into the host. */
const hostToken = Effect.gen(function* () {
  const Token = yield* BotToken;
  const self = yield* Self;
  const token = yield* Token(`${self.LogicalId}SlackBotToken`);
  return {
    token: yield* token.value,
    apiBaseUrl: yield* token.apiBaseUrl,
  } satisfies TokenSource;
});

/** Provide the bound token to a distilled call. Credentials resolve per request. */
const authorize =
  (source: TokenSource) =>
  <A, E>(effect: Effect.Effect<A, E, SlackOpContext>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            Credentials,
            Effect.all([source.token, source.apiBaseUrl]).pipe(
              Effect.map(([token, apiBaseUrl]) => tokenConfig(token, apiBaseUrl)),
            ),
          ),
          FetchHttpClient.layer,
        ),
      ),
    );

/**
 * A binding to one channel: every call targets the bound channel's ID, read
 * from the host's environment at runtime.
 */
export const makeChannelBinding = <In extends { channel?: string | undefined }, Out, E>(options: {
  readonly name: string;
  readonly operation: (request: In) => Effect.Effect<Out, E, SlackOpContext>;
}) =>
  Effect.gen(function* () {
    const source = yield* hostToken;
    const call = authorize(source);
    return Effect.fn(function* (channel: Channel) {
      const channelId = yield* channel.channelId;
      return Effect.fn(`Slack.${options.name}(${channel.LogicalId})`)(function* (
        request: Omit<In, "channel">,
      ) {
        return yield* call(options.operation({ ...request, channel: yield* channelId } as In));
      });
    });
  });

/** A workspace-wide binding: the call takes its whole request. */
export const makeWorkspaceBinding = <In, Out, E>(options: {
  readonly name: string;
  readonly operation: (request: In) => Effect.Effect<Out, E, SlackOpContext>;
}) =>
  Effect.gen(function* () {
    const source = yield* hostToken;
    const call = authorize(source);
    return Effect.fn(function* () {
      return Effect.fn(`Slack.${options.name}`)(function* (request: In) {
        return yield* call(options.operation(request));
      });
    });
  });

/** Like {@link makeWorkspaceBinding}, exposing the raw authorized caller. */
export const makeAuthorizedCaller = Effect.gen(function* () {
  return authorize(yield* hostToken);
});
