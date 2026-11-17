import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Golden } from "./src/Golden.ts";

export default Alchemy.Stack(
  "ArchilSandboxExample",
  { providers: Archil.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const golden = yield* Golden;
    const api = yield* Api;
    return { sandbox: golden.name, url: api.url };
  }),
);
