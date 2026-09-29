import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Chat from "./Hello.ts";

// #region show
export default Alchemy.Stack(
  "Chat",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const chat = yield* Chat;
    return { url: chat.url.as<string>() };
  }),
);
// #endregion show
