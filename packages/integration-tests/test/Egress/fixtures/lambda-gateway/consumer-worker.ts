import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { LambdaTestGateway, READ_REPO } from "./gateway.ts";

/**
 * Yields the Lambda-hosted gateway (its function URL, and `lambda:InvokeFunction`
 * on it) and mints grants:
 *
 * GET /grant?ttl=<ms>  → `{ routes, minted }` for the repo (narrowed)
 * GET /refused         → asks for a repository the gateway isn't configured for
 * GET /transport       → how the gateway is reached
 */
export default class LambdaGatewayConsumer extends Cloudflare.Worker<LambdaGatewayConsumer>()(
  "EgressLambdaGatewayConsumer",
  { main: import.meta.url },
  Effect.gen(function* () {
    const gateway = yield* LambdaTestGateway;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/transport") {
          return yield* HttpServerResponse.json({
            transport: gateway.repo.gateway.transport,
            url: yield* gateway.repo.gateway.url,
          });
        }
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
          [gateway.repo.narrow({ repository: READ_REPO, graphql: false })],
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
