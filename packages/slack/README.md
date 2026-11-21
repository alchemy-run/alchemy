# @alchemy.run/slack

[Slack](https://slack.com) for [Alchemy](https://alchemy.run). Declare a workspace's channels, user groups, canvases and apps next to the Workers that post to them and receive their events.

```sh
npm install alchemy @alchemy.run/slack @alchemy.run/cloudflare effect
```

A channel, and a Worker that posts to it and answers when the bot is mentioned:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Slack from "@alchemy.run/slack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const Alerts = Slack.Channel("Alerts", { topic: "Production alerts" });

class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const post = yield* Slack.PostMessage(yield* Alerts);

    yield* Slack.consumeEvents(
      "BotApp",
      {
        manifest: {
          features: { bot_user: { display_name: "alerts-bot" } },
          oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write"] } },
        },
        events: ["app_mention"],
      },
      Effect.fn(function* (delivery) {
        yield* post({ text: `<@${delivery.event.user}> on it.` }).pipe(Effect.orDie);
      }),
    );

    return {};
  }).pipe(Effect.provide(Layer.mergeAll(Slack.PostMessageHttp, Slack.ConsumeEventsLive))),
) {}

export default Alchemy.Stack(
  "SlackBot",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Slack.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Alerts;
    const bot = yield* Bot;
    return { url: bot.url };
  }),
);
```

Run `alchemy profile edit --add Slack` to store your app's bot token and an app configuration token. See [Setup](https://alchemy.run/slack/setup) and the [reference](https://alchemy.run/providers/slack/).
