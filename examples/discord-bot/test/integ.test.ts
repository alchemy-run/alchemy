import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Discord from "@alchemy.run/discord";
import * as Test from "@alchemy.run/test/Bun";
import * as discord from "@distilled.cloud/discord/discord";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Discord.providers()),
  state: Alchemy.localState(),
});

// Out-of-band calls use the same stored bot token as the deploy.
const DiscordHttp = Layer.mergeAll(Discord.fromAuthProvider(), FetchHttpClient.layer).pipe(
  Layer.provideMerge(Discord.DiscordAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

test(
  "the deployed Worker is the interactions endpoint and posts through the webhook",
  Effect.gen(function* () {
    const { url, deploysChannelId } = yield* stack;
    const base = url.replace(/\/+$/, "");

    const app = yield* discord.getMyApplication({}).pipe(Effect.provide(DiscordHttp));
    expect(app.interactions_endpoint_url).toBe(`${base}/__alchemy/discord/interactions`);

    const response = yield* Test.executeWhenReady(
      HttpClientRequest.post(`${base}/deployed`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ version: "v1.2.3" }),
      ),
    );
    const { messageId } = (yield* response.json) as { messageId: string };
    const message = yield* discord
      .getMessage({ channel_id: deploysChannelId, message_id: messageId })
      .pipe(Effect.provide(DiscordHttp));
    expect(message.content).toBe("Deployed v1.2.3");
  }),
  { timeout: 120_000 },
);
