/**
 * E2E composition smoke: the WHOLE engineer Layer graph — the charter,
 * the read/run/write toolbox over a fixed workspace, driver + model,
 * sqlite durability — builds against real physics, the charter
 * interprets, and the chat projection is readable.
 *
 * Gated on `ANTHROPIC_API_KEY` (the model layer reads it at build);
 * without it the test skips.
 */
import * as AI from "alchemy/AI";
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EngineerLocal as Local } from "../src/Server.ts";

const hasCredentials = process.env.ANTHROPIC_API_KEY !== undefined;

test.skipIf(!hasCredentials)(
  "the engineer composes end-to-end and reads its world",
  async () => {
    const chats = await Effect.runPromise(
      Effect.gen(function* () {
        const projection = yield* AI.Chats;
        return yield* projection.list();
      }).pipe(
        Effect.provide(Local),
        Effect.provide(BunServices.layer),
        Effect.scoped,
      ) as Effect.Effect<ReadonlyArray<AI.ChatSummary>>,
    );
    expect(Array.isArray(chats)).toBe(true);
  },
  30_000,
);
