import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Chat from "./src/Chat.ts";
import { Inference } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitAiExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const token = yield* Inference;
    const chat = yield* Chat;

    return {
      url: chat.url,
      projectId: token.projectId,
      region: token.region,
      tokenId: token.tokenId,
    };
  }),
);
