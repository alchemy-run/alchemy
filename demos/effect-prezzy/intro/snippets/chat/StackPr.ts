import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Chat from "./Chat.ts";

// #region show
export default Alchemy.Stack(
  "Chat",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const chat = yield* Chat;
    // #region comment

    if (process.env.PULL_REQUEST) {
      yield* GitHub.Comment("Preview", {
        owner: "alchemy-run",
        repository: "chat",
        issueNumber: Number(process.env.PULL_REQUEST),
        body: Output.interpolate`🚀 Preview deployed to ${chat.url}`,
      });
    }
    // #endregion comment
    return { url: chat.url.as<string>() };
  }),
);
// #endregion show
