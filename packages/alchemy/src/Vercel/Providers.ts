import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Command from "../Command/index.ts";
import * as Provider from "../Provider.ts";
import { ClientLive, HttpLive } from "./Client.ts";
import { CredentialsFromEnv } from "./Credentials.ts";
import { Record, RecordProvider } from "./DNS/Record.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Vercel",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Vercel resource providers plus resolved
 * `Credentials` and an `HttpClient`. Include it from your stack alongside
 * other cloud `providers()` layers.
 *
 * Credentials resolve from `VERCEL_TOKEN` (plus optional `VERCEL_TEAM_ID` /
 * `VERCEL_TEAM_SLUG`).
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Vercel.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Record])).pipe(
    Layer.provide(RecordProvider()),
    Layer.provideMerge(ClientLive),
    Layer.provideMerge(CredentialsFromEnv),
    Layer.provideMerge(HttpLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
  );
