import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface InteractionsEndpointProps {
  /**
   * HTTPS URL Discord POSTs interactions to (slash commands, buttons,
   * modals, autocomplete). Discord sends a signed PING when it is set and
   * refuses a URL that doesn't answer it, so the endpoint must already be
   * deployed and verifying signatures.
   */
  url: string;
}

export interface InteractionsEndpointAttributes {
  /** Application id. */
  applicationId: string;
  /** The registered URL. */
  url: string;
  /** Hex Ed25519 public key interaction requests are signed with. */
  publicKey: string;
  /** The URL before the stack managed it; destroy restores it. */
  initialUrl: string | null;
}

/**
 * The application's interactions endpoint URL: where Discord delivers slash
 * commands, component clicks, modal submits and autocomplete over HTTP
 * instead of the Gateway.
 *
 * `Discord.consumeInteractions` declares this for you, pointing at the host
 * it runs on. Declare it directly to point Discord at an endpoint you run
 * yourself. Discord verifies the URL when it is set, so the host must be
 * deployed first (an Output of the host's URL orders that). Destroy restores
 * the previous URL.
 *
 * ### Pointing Discord at an Endpoint
 * **Example:** A Worker you wrote yourself
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Interactions", { main: "./src/interactions.ts" });
 * yield* Discord.InteractionsEndpoint("Endpoint", {
 *   url: Output.interpolate`${worker.url}/interactions`,
 * });
 * ```
 *
 * @resource
 * @product Interaction
 */
export interface InteractionsEndpoint extends Resource<
  "Discord.InteractionsEndpoint",
  InteractionsEndpointProps,
  InteractionsEndpointAttributes,
  never,
  Providers
> {}

export const InteractionsEndpoint = Resource<InteractionsEndpoint>("Discord.InteractionsEndpoint");

const toAttributes = (
  app: discord.PrivateApplicationResponse,
  initialUrl: string | null,
): InteractionsEndpointAttributes => ({
  applicationId: app.id,
  url: app.interactions_endpoint_url ?? "",
  publicKey: app.verify_key,
  initialUrl,
});

export const InteractionsEndpointProvider = () =>
  Provider.succeed(InteractionsEndpoint, {
    nuke: { singleton: true },
    stables: ["applicationId", "publicKey"],

    read: Effect.fn(function* ({ output }) {
      const app = yield* discord.getMyApplication({});
      if (app.interactions_endpoint_url === null) return undefined;
      return toAttributes(app, output?.initialUrl ?? app.interactions_endpoint_url);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const app = yield* discord.getMyApplication({});
      const initialUrl = output !== undefined ? output.initialUrl : app.interactions_endpoint_url;
      if (app.interactions_endpoint_url === news.url) return toAttributes(app, initialUrl);
      const updated = yield* discord.updateMyApplication({ interactions_endpoint_url: news.url });
      return toAttributes(updated, initialUrl);
    }),

    delete: Effect.fn(function* ({ output }) {
      const app = yield* discord.getMyApplication({});
      // Someone else moved it since; leave theirs alone.
      if (app.interactions_endpoint_url !== output.url) return;
      yield* discord.updateMyApplication({
        interactions_endpoint_url: output.initialUrl === output.url ? null : output.initialUrl,
      });
    }),

    list: () => Effect.succeed([]),
  });
