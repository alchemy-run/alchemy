import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
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
