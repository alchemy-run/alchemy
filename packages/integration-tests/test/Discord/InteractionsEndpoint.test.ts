import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { tags } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

/**
 * The success path (a URL Discord verifies) is exercised by
 * Interactions.test.ts, which deploys a Worker that answers the PING. This
 * suite pins the failure path: a URL that doesn't answer is refused with the
 * typed tag, after the bounded retry, and nothing is left registered.
 */
test.provider(
  "a URL that doesn't answer Discord's PING is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Discord.InteractionsEndpoint("Endpoint", {
            url: "https://example.com/alchemy-discord-interactions",
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("InteractionsEndpointUnverified");
      yield* stack.destroy();
    }),
  { tags: tags("interactions-endpoint"), timeout: 120_000, exclusive: "discord:application" },
);
