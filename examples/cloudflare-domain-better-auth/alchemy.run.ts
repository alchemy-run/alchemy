import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import NotesWorker from "./src/NotesWorker.ts";

export default Alchemy.Stack(
  "DomainBetterAuth",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const notes = yield* NotesWorker;
    return { url: notes.url.as<string>() };
  }),
);
