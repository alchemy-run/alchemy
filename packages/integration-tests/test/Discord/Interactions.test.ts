import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Discord from "@alchemy.run/discord";
import { interactionsPath } from "@alchemy.run/discord/Interactions";
import { webhookEventsPath } from "@alchemy.run/discord/WebhookEvents";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import DiscordInteractionsWorker from "./fixtures/interactions-worker.ts";
import { dc, tags } from "./helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Discord.providers()),
});

/**
 * Deploying the Worker registers its URL as the application's interactions
 * endpoint and event webhook. Discord sends each URL a signed PING and
 * refuses to save it unless the Worker verifies the signature and answers,
 * so a successful deploy is the end-to-end proof; the forged requests below
 * prove unsigned ones are refused.
 */
test.provider(
  "consumeInteractions and consumeWebhookEvents register a verified endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = dc(discord.getMyApplication({}));
      const before = yield* app;

      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DiscordInteractionsWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const base = url.replace(/\/+$/, "");
      const during = yield* app;
      expect(during.interactions_endpoint_url).toBe(`${base}${interactionsPath({})}`);
      expect(during.event_webhooks_url).toBe(`${base}${webhookEventsPath({})}`);
      expect(during.event_webhooks_types).toEqual(["APPLICATION_AUTHORIZED"]);

      // An unsigned PING is refused.
      const forged = yield* Test.executeWhenReady(
        HttpClientRequest.post(`${base}${interactionsPath({})}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ type: 1 }),
        ),
      );
      expect(forged.status).toBe(401);
      // So is a bad signature.
      const badSig = yield* Test.executeWhenReady(
        HttpClientRequest.post(`${base}${webhookEventsPath({})}`).pipe(
          HttpClientRequest.setHeaders({
            "x-signature-ed25519": "00".repeat(64),
            "x-signature-timestamp": "1",
          }),
          HttpClientRequest.bodyJsonUnsafe({ type: 0 }),
        ),
      );
      expect(badSig.status).toBe(401);

      yield* stack.destroy();
      const after = yield* app;
      expect(after.interactions_endpoint_url).toBe(before.interactions_endpoint_url);
      expect(after.event_webhooks_url ?? null).toBe(before.event_webhooks_url ?? null);
    }),
  {
    tags: [...tags("interactions"), "provider:cloudflare", "provider:cloudflare:worker"],
    timeout: 300_000,
    exclusive: "discord:application",
  },
);
