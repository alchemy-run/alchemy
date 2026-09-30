import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Stack from "./alchemy.run.ts";
import { connect, history } from "./client.ts";

// #region show
// #region make
// #region local
const local = Effect.runSync(Config.Boolean("LOCAL").pipe(Config.withDefault(false)));

// #endregion local
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
  // #region dev
  dev: local,
  // #endregion dev
  // #region stage
  stage: process.env.STAGE,
  // #endregion stage
});
// #endregion make
// #region deploy

const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));
// #endregion deploy
// #region test

test(
  "a message reaches everyone in the room",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const alice = yield* connect(`${url}/rooms/lobby`);
    const bob = yield* connect(`${url}/rooms/lobby`);

    yield* alice.send("hi bob");
    expect(yield* bob.receive).toBe("hi bob");
    // #region history
    expect(yield* history(url, "lobby")).toContain("hi bob");
    // #endregion history
  }),
);
// #endregion test
// #endregion show
