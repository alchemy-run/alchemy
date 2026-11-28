import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class AliasTarget extends Cloudflare.Worker<AliasTarget>()(
  "AliasTarget",
  { main: import.meta.url },
  Effect.succeed({
    greet: (name: string) => Effect.succeed(`hello ${name} from alias target`),
    fetch: Effect.succeed(HttpServerResponse.text("alias target")),
  }),
) {}
