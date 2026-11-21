import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { tags } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

/**
 * The success path is exercised by Interactions.test.ts (consumeWebhookEvents
 * on a deployed Worker). This pins the refusal of a URL that doesn't answer.
 */
test.provider(
  "a URL that doesn't answer Discord's PING is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Discord.EventWebhook("Events", {
            url: "https://example.com/alchemy-discord-events",
            types: ["APPLICATION_AUTHORIZED"],
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("InvalidFormBody");
      yield* stack.destroy();
    }),
  { tags: tags("event-webhook"), timeout: 120_000, exclusive: "discord:application" },
);
