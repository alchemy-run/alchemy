/**
 * E2E composition smoke: the WHOLE org Layer graph — both charters
 * (engineer + review bot), the toolbox over the routed workspace,
 * driver + model, sqlite durability, GitHub physics — builds against
 * real physics, the charters interpret, and the session index is
 * readable.
 *
 * Gated on `ANTHROPIC_API_KEY` (the model layer reads it at build);
 * without it the test skips.
 */
import * as AI from "alchemy/AI";
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Org as Local } from "../src/Server.ts";

const hasCredentials = process.env.ANTHROPIC_API_KEY !== undefined;

test.skipIf(!hasCredentials)(
  "the org composes end-to-end and reads its world",
  async () => {
    const chats = await Effect.runPromise(
      Effect.gen(function* () {
        const index = yield* AI.SessionIndex;
        return yield* index.list();
      }).pipe(
        Effect.provide(Local),
        Effect.provide(BunServices.layer),
        Effect.scoped,
      ) as Effect.Effect<ReadonlyArray<AI.SessionSummary>>,
    );
    expect(Array.isArray(chats)).toBe(true);
  },
  30_000,
);
