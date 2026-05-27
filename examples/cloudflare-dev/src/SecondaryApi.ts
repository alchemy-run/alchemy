import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import NotifyWorkflow from "./NotifyWorkflow.ts";

export default class SecondaryApi extends Cloudflare.Worker<SecondaryApi>()(
  "SecondaryApi",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const workflow = yield* NotifyWorkflow;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://internal");
        if (url.pathname.startsWith("/workflow/start/")) {
          const roomId = url.pathname.split("/workflow/start/")[1];
          if (!roomId) {
            return yield* HttpServerResponse.json(
              { error: "roomId is required" },
              { status: 400 },
            );
          }
          const instance = yield* workflow.create({
            roomId,
            message: "hello from secondary",
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        } else if (url.pathname.startsWith("/workflow/status/")) {
          const instanceId = url.pathname.split("/workflow/status/")[1];
          if (!instanceId) {
            return yield* HttpServerResponse.json(
              { error: "instanceId is required" },
              { status: 400 },
            );
          }
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        }
        return HttpServerResponse.text("secondary ok");
      }),
    };
  }).pipe(Effect.provide([Cloudflare.KVNamespaceBindingLive])),
) {}
