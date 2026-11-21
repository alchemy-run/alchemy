import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Gateway from "alchemy/Gateway";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Repo } from "./e2b-git.ts";

/**
 * A Durable Object whose own Construction asks for a binding that runs in
 * its Worker's gateway. This is where a harness and its tools live.
 */
export class Pusher extends Cloudflare.DurableObject<Pusher>()(
  "GatewayPusher",
  Effect.gen(function* () {
    const repo = yield* GitHub.PushRepository(Repo);
    return Effect.succeed({
      remote: () => repo.remote,
    });
  }).pipe(
    Effect.provide(
      GitHub.PushRepositoryHttp.pipe(
        Layer.provide(Gateway.only(GitHub.PushRepository)),
        Layer.provide(Cloudflare.Workers.SandboxGateway),
      ),
    ),
  ),
) {}

export default class DurableObjectWorker extends Cloudflare.Worker<DurableObjectWorker>()(
  "GatewayDurableObjectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const pushers = yield* Pusher;
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* pushers.getByName("main").remote());
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
