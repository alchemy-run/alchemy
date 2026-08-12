import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import LocalFuseBoxRuntime from "./local-runtime.ts";
import { LocalFusePersist } from "./local-storage.ts";
import LocalFuseWorker from "./local-worker.ts";

/**
 * Same arrangement as `stack.ts`, under a distinct stack name AND
 * distinct fixture identities (`LocalFuse*`) so the dev-mode test never
 * shares state, a container application, or a workers.dev worker with
 * the live `FuseMount.test.ts` deployment when the two files run
 * concurrently.
 */
export default Alchemy.Stack(
  "R2FuseMountLocalStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* LocalFusePersist;
    const worker = yield* LocalFuseWorker;
    return {
      url: worker.url.as<string>(),
      bucketName: bucket.bucketName.as<string>(),
    };
  }).pipe(Effect.provide(LocalFuseBoxRuntime)),
);
