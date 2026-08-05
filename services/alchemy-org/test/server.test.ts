/**
 * E2E composition smoke: the WHOLE bot Layer graph — the ReviewBot
 * charter, the QA skill and toolbox, GitHub bindings, kernel + model,
 * ledger, event polling — builds against real physics, the charter
 * interprets, the poller registers, and the chat projection is
 * readable.
 *
 * Gated on the runtime credentials (`GITHUB_ACCESS_TOKEN`/`GITHUB_TOKEN`
 * and `ANTHROPIC_API_KEY`); without them the test skips.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Local } from "../src/Local.ts";

/**
 * The GitHub Providers requirement is PHANTOM on this path: the bot
 * resolves `testAlchemy`'s identity from its static owner/name props
 * (see RepositoryLike.resolveRepository), never through the provider
 * collection — same situation as the detached runtime, which provides
 * nothing for it either.
 */
const ProvidersPhantom = Layer.succeed(GitHub.Providers, undefined as never);

const hasCredentials =
  (process.env.GITHUB_ACCESS_TOKEN !== undefined ||
    process.env.GITHUB_TOKEN !== undefined) &&
  process.env.ANTHROPIC_API_KEY !== undefined;

test.skipIf(!hasCredentials)(
  "the bot composes end-to-end and reads its world",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // the sqlite ledger needs its directory to exist
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(".alchemy", { recursive: true });

        yield* Effect.gen(function* () {
          const chats = yield* AI.Chats;
          const list = yield* chats.list();
          expect(Array.isArray(list)).toBe(true);
        }).pipe(
          Effect.provide(Local),
          Effect.provide(ProvidersPhantom),
          Effect.scoped,
        );
      }).pipe(Effect.provide(BunServices.layer), Effect.scoped),
    ),
  60_000,
);
