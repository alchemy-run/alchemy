import type * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Match from "effect/Match";
import { OpenCodeAgents, PiAgents } from "./Hosts.ts";
import { Adder, Operator } from "./Processes.ts";

/** The processes of one host, by name. */
const processes = Effect.gen(function* () {
  const clients: Record<string, AI.ProcessClient<any>> = {
    Adder: yield* Adder,
    Operator: yield* Operator,
  };
  return clients;
});

/** Drives the processes of each host over HTTP: `POST /<harness>/<process>/<key>/<action>`. */
export default class ProcessApi extends Cloudflare.Worker<ProcessApi>()(
  "ProcessApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hosts: Record<string, Record<string, AI.ProcessClient<any>>> = {
      pi: yield* processes.pipe(Effect.provide(AICloudflare.ProcessClient(PiAgents))),
      opencode: yield* processes.pipe(Effect.provide(AICloudflare.ProcessClient(OpenCodeAgents))),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, harness, name, key, action] = new URL(request.url, "http://api").pathname.split(
          "/",
        );
        const process = hosts[harness ?? ""]?.[name ?? ""];
        if (process === undefined || key === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const body = (yield* request.json) as {
          readonly input?: unknown;
          readonly text?: string;
          readonly requestId?: string;
        };
        const sent = body.requestId === undefined ? {} : { requestId: body.requestId };
        const session = process.get(key);
        const answer = yield* Match.value(action).pipe(
          Match.when("start", () => Effect.as(process.start(key, body.input), { ok: true })),
          Match.when("send", () => Effect.as(session.send(body.text ?? "", sent), { ok: true })),
          Match.when("prompt", () => session.prompt(body.text ?? "", sent)),
          Match.when("wait", () => Effect.as(session.wait, { ok: true })),
          Match.when("abort", () => Effect.as(session.abort, { ok: true })),
          Match.when("messages", () =>
            Effect.map(session.messages, (messages) => ({ messages: JSON.stringify(messages) })),
          ),
          Match.orElse(() => Effect.succeed(undefined)),
          // A session that never started is an answer, not a failure of the route.
          Effect.catchTag("NotStarted", ({ _tag, process, key }) =>
            Effect.succeed({ _tag, process, key }),
          ),
        );
        return answer === undefined
          ? HttpServerResponse.text("not found", { status: 404 })
          : yield* HttpServerResponse.json(answer);
      }).pipe(
        // Answer with the failure, so a test can say what went wrong.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
