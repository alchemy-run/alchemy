import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import ProgramBoxLive from "./box.runtime.ts";
import ProgramBoxWorker from "./worker.ts";

export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "ProgramBoxStack",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* ProgramBoxWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(ProgramBoxLive)),
);
