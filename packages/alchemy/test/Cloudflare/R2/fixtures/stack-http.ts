import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import ReadHttpWorker from "./read-http.ts";
import ReadWriteHttpWorker from "./readwrite-http.ts";
import WriteHttpWorker from "./write-http.ts";

/**
 * Deploys the three Workers that reach one shared R2 bucket over a
 * **scoped HTTP API token** (`*BucketHttp`) — read / write /
 * read-write.
 *
 * Kept apart from the native-binding stack ({@link ./stack.ts}) so that
 * minting the `AccountApiToken` these workers depend on cannot take down
 * binding coverage that needs no token at all. Inspect directly with:
 *
 * ```sh
 * alchemy tail --stage test ./test/Cloudflare/R2/fixtures/stack-http.ts
 * ```
 */
export default Alchemy.Stack(
  "R2BindingHttpStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const readHttp = yield* ReadHttpWorker;
    const writeHttp = yield* WriteHttpWorker;
    const readWriteHttp = yield* ReadWriteHttpWorker;
    return {
      readHttp: readHttp.url.as<string>(),
      writeHttp: writeHttp.url.as<string>(),
      readWriteHttp: readWriteHttp.url.as<string>(),
    };
  }),
);
