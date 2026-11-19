// alchemy.run.ts
import * as Boat from "@alchemy.run/boat";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "BoatProgramExample",
  { providers: Boat.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url.as<string>(), sandboxId: api.sandboxId };
  }),
);
