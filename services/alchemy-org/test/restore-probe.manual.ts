import * as AI from "alchemy/AI";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import { Local } from "/Users/samgoodwin/workspaces/alchemy-effect/services/alchemy-org/src/Local.ts";

console.log("building Local layer...");
const chats = await Effect.runPromise(
  Effect.gen(function* () {
    yield* Effect.log("inside build");
    const projection = yield* AI.Chats;
    yield* Effect.log("chats resolved");
    return yield* projection.list();
  }).pipe(
    Effect.provide(Local),
    Effect.provide(BunServices.layer),
    Effect.scoped,
  ) as Effect.Effect<unknown>,
);
console.log("built:", JSON.stringify(chats).slice(0, 200));
process.exit(0);
