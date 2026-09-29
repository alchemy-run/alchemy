import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Chat from "./Chat.ts";

// #region show
export default Alchemy.Stack(
  "Chat",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const chat = yield* Chat;
    return { url: chat.url.as<string>() };
  }),
);
// #endregion show
