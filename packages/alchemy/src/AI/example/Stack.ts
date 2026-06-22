import * as Alchemy from "alchemy";
import { Effect, Layer } from "effect";
import * as Cloudflare from "../../Cloudflare/index.ts";
import * as GitHub from "../../GitHub/index.ts";
import ReleaseService from "./ReleaseService.ts";

export default Alchemy.Stack(
  "Stack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const releaseService = yield* ReleaseService;

    return {
      releaseService: releaseService.url.as<string>(),
    };
  }),
);
