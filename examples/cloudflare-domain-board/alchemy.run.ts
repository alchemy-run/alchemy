import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import BoardWorker from "@board/server/BoardWorker";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "CloudflareDomainBoard",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const board = yield* BoardWorker;
    // The same token the Worker's Session middleware checks: one declaration, made once.
    const token = yield* Alchemy.Random("BoardToken");
    return {
      url: board.url.as<string>(),
      token: token.text,
    };
  }),
);
