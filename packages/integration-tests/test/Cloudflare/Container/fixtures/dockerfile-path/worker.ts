import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ContextRelative, AbsolutePath } from "./containers.ts";

export class ContextRelativeObject extends Cloudflare.DurableObject<ContextRelativeObject>()(
  "DockerfileContextRelativeObject",
  Effect.gen(function* () {
    yield* ContextRelative;
    return Effect.succeed({});
  }),
) {}

export class AbsolutePathObject extends Cloudflare.DurableObject<AbsolutePathObject>()(
  "DockerfileAbsolutePathObject",
  Effect.gen(function* () {
    yield* AbsolutePath;
    return Effect.succeed({});
  }),
) {}

export default class DockerfilePathWorker extends Cloudflare.Worker<DockerfilePathWorker>()(
  "DockerfilePathWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* ContextRelativeObject;
    yield* AbsolutePathObject;
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
