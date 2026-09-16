import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import FuseBoxRuntime from "./runtime.ts";
import { Persist } from "./storage.ts";
import FuseWorker from "./worker.ts";

export default Alchemy.Stack(
  "R2FuseMountStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Persist;
    const worker = yield* FuseWorker;
    return {
      url: worker.url.as<string>(),
      bucketName: bucket.bucketName.as<string>(),
    };
  }).pipe(
    // the `.make()` default export registers the container's runtime;
    // providing it is what builds the image and deploys the application
    Effect.provide(FuseBoxRuntime),
  ),
);
