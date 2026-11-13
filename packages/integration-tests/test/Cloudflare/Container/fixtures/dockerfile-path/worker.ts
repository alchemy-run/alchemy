import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ContextRelative, CwdRelative } from "./containers.ts";

export class ContextRelativeObject extends Cloudflare.DurableObject<ContextRelativeObject>()(
  "DockerfileContextRelativeObject",
  Effect.gen(function* () {
    yield* ContextRelative;
    return Effect.succeed({});
  }),
) {}

export class CwdRelativeObject extends Cloudflare.DurableObject<CwdRelativeObject>()(
  "DockerfileCwdRelativeObject",
  Effect.gen(function* () {
    yield* CwdRelative;
    return Effect.succeed({});
  }),
) {}

export default class DockerfilePathWorker extends Cloudflare.Worker<DockerfilePathWorker>()(
  "DockerfilePathWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* ContextRelativeObject;
    yield* CwdRelativeObject;
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
