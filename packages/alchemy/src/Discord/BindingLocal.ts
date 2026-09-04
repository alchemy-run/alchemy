/**
 * Shared scaffolding for the Discord `*Local` binding implementations —
 * the Discord analogue of the GitHub `BindingLocal.ts` convention.
 *
 * Instead of capturing a {@link BotToken} resource and binding its
 * value into a host (the `*Http` path), `make(op)` runs the SAME
 * operation off the provider's ambient {@link DiscordCredentials} —
 * the laptop factory and tests authenticate with whatever
 * `DISCORD_BOT_TOKEN` resolved, no resource, no bind.
 *
 * NOT exported from `index.ts` (internal scaffolding).
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { type Operation, makeOperationClient } from "./BindingHttp.ts";
import { DiscordCredentials } from "./Credentials.ts";

/**
 * Build the ambient-credentials implementation Effect of a Discord
 * binding — pass the result straight to `Layer.effect(Tag, …)`:
 *
 * ```ts
 * export const ListMessagesLocal = Layer.effect(
 *   ListMessages,
 *   BindingLocal.make(listMessagesOperation),
 * );
 * ```
 */
export const make = <Request extends ReadonlyArray<any>, Out>(
  op: Operation<Request, Out>,
) =>
  Effect.gen(function* () {
    const credentials = yield* yield* DiscordCredentials;
    const client = yield* HttpClient.HttpClient;
    return makeOperationClient(op, client, Effect.succeed(credentials.token));
  });
