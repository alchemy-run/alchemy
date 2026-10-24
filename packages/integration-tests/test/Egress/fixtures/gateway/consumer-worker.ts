import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { READ_REPO, TestGateway } from "./gateway.ts";

/**
 * Yields the gateway (a service binding to its Worker) and mints grants:
 *
 * GET /grant?ttl=<ms>  → `{ routes, minted }` for the repo (narrowed) and echo egresses
 * GET /refused         → asks for a repository the gateway isn't configured for
 */
export default class ConsumerWorker extends Cloudflare.Worker<ConsumerWorker>()(
  "EgressConsumerWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const gateway = yield* TestGateway;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/refused") {
          const result = yield* Effect.result(
            Egress.grant([gateway.repo.narrow({ repository: "cli/cli" })]),
          );
          return yield* HttpServerResponse.json(
            result._tag === "Failure"
              ? { error: result.failure._tag, message: result.failure.message }
              : { error: null },
          );
        }
        const ttl = Number(url.searchParams.get("ttl") ?? 300_000);
        const granted = yield* Egress.grant(
          [gateway.repo.narrow({ repository: READ_REPO, graphql: false }), gateway.echo],
          { ttl },
        );
        return yield* HttpServerResponse.json(granted);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
