import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Files } from "./src/Storage.ts";

export const Hello = Archil.Sandbox("Hello", {
  main: "./src/hello.ts",
  port: 3001,
  env: { GREETING: "hello" },
});

export type HelloEnv = Archil.InferEnv<typeof Hello>;

export default Alchemy.Stack(
  "ArchilSandboxExample",
  { providers: Archil.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const files = yield* Files;
    const api = yield* Api;
    const hello = yield* Hello;
    return { diskId: files.diskId, url: api.url, helloUrl: hello.url };
  }),
);
