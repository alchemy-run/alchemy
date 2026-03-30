// import { Stage } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
// import * as GitHub from "alchemy-effect/GitHub";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

export default Stack.make(
  "CloudflareTanstackExample",
  Cloudflare.providers(),
)(
  Effect.gen(function* () {
    // const stage = yield* Stage;

    const worker = yield* Worker;

    // if (stage.startsWith("pr-")) {
    //   yield* GitHub.Comment("Preview")`Preview deployed to ${worker.url}`;
    // }

    return {
      url: worker.url,
    };
  }),
);
