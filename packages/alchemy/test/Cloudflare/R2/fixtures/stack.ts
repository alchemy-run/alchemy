import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import ReadBindingWorker from "./read-binding.ts";
import ReadWriteBindingWorker from "./readwrite-binding.ts";
import WriteBindingWorker from "./write-binding.ts";

/**
 * Deploys the three Workers that reach one shared R2 bucket over the
 * **native Worker binding** (`*BucketBinding`) — read / write /
 * read-write. Extracted into its own stack file so it can be deployed
 * by the test suite AND inspected directly, e.g.
 *
 * ```sh
 * alchemy tail --stage test ./test/Cloudflare/R2/fixtures/stack.ts
 * ```
 *
 * The HTTP-token half lives in a separate stack ({@link ./stack-http.ts})
 * because deploying it mints an `AccountApiToken`, which not every
 * credential is permitted to do — see the gate in `../Binding.test.ts`.
 */
export default Alchemy.Stack(
  "R2BindingStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const readBinding = yield* ReadBindingWorker;
    const writeBinding = yield* WriteBindingWorker;
    const readWriteBinding = yield* ReadWriteBindingWorker;
    return {
      readBinding: readBinding.url.as<string>(),
      writeBinding: writeBinding.url.as<string>(),
      readWriteBinding: readWriteBinding.url.as<string>(),
    };
  }),
);
