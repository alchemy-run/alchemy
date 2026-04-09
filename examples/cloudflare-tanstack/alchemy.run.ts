// import { Stage } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
// import * as GitHub from "alchemy-effect/GitHub";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

export default Stack.make(
  "CloudflareTanstackExample",
  Cloudflare.providers(),
)(
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("TanStack", {
      main: undefined!,
      vite: {},
      compatibility: {
        date: "2026-04-09",
        flags: ["nodejs_compat"],
      },
    });

    // if (stage.startsWith("pr-")) {
    //   yield* GitHub.Comment("Preview")`Preview deployed to ${worker.url}`;
    // }

    return {
      url: worker.url,
    };
  }),
);
