import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "DigitalOceanApp",
  {
    providers: DigitalOcean.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
