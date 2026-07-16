import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import RemoteContainerWorker from "./worker.ts";

/**
 * Same worker/DO/container arrangement as `stack.ts`, under a distinct stack
 * name so the local-dev test (`LocalContainer.test.ts`) never shares state
 * with the live `Container.test.ts` deployment.
 */
export default Alchemy.Stack(
  "LocalRemoteContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* RemoteContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
