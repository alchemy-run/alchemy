import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as GitHub from "@alchemy.run/github";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Repo } from "./e2b-git.ts";

/**
 * A sandbox whose binding Layer is built before its gateway's: the token
 * the binding bound is moved to the gateway when the gateway is installed.
 */
export default class OrderSandbox extends E2B.Template<OrderSandbox>()(
  "GatewayOrderSandbox",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const listIssues = yield* GitHub.ListIssues(Repo);
    return {
      fetch: Effect.gen(function* () {
        const issues = yield* listIssues({ per_page: 1 });
        const environment = JSON.stringify(yield* Effect.sync(() => process.env));
        return yield* HttpServerResponse.json({
          listed: Array.isArray(issues),
          token: /gh[opsu]_|github_pat_/.test(environment),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      // The wrong way round on purpose: the gateway is built after the binding.
      Cloudflare.Workers.SandboxGateway.pipe(Layer.provideMerge(GitHub.ListIssuesHttp)),
    ),
  ),
) {}
