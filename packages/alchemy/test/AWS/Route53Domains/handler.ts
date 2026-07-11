import * as Lambda from "@/AWS/Lambda";
import * as Route53Domains from "@/AWS/Route53Domains";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class Route53DomainsTestFunction extends Lambda.Function<Lambda.Function>()(
  "Route53DomainsTestFunction",
) {}

export default Route53DomainsTestFunction.make(
  {
    main,
    url: true,
    // Route 53 Domains calls cross to us-east-1; give cold starts headroom
    // over the 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const checkDomainAvailability =
      yield* Route53Domains.CheckDomainAvailability();
    const getDomainDetail = yield* Route53Domains.GetDomainDetail();
    const listDomains = yield* Route53Domains.ListDomains();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Route 53 Domains call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/availability") {
          const result = yield* checkDomainAvailability({
            // Deterministic probe name — availability checks are read-only
            // and free; this suite NEVER registers a domain.
            DomainName: "alchemy-effect-r53d-probe-a32892.com",
          });
          return yield* HttpServerResponse.json({
            availability: result.Availability,
          });
        }

        if (request.method === "GET" && pathname === "/domains") {
          const result = yield* listDomains({ MaxItems: 100 });
          return yield* HttpServerResponse.json({
            count: (result.Domains ?? []).length,
            names: (result.Domains ?? [])
              .map((domain) => domain.DomainName)
              .filter((name) => name !== undefined),
          });
        }

        if (request.method === "GET" && pathname === "/detail") {
          // example.com is never registered in the test account — the call
          // must reach the API (proving the IAM grant and us-east-1 pin)
          // and come back as a typed domain-level error, not AccessDenied.
          const result = yield* Effect.result(
            getDomainDetail({ DomainName: "example.com" }),
          );
          if (Result.isFailure(result)) {
            return yield* HttpServerResponse.json({
              ok: false,
              errorTag: result.failure._tag,
            });
          }
          return yield* HttpServerResponse.json({
            ok: true,
            domainName: result.success.DomainName,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Route53Domains.CheckDomainAvailabilityHttp,
        Route53Domains.GetDomainDetailHttp,
        Route53Domains.ListDomainsHttp,
      ),
    ),
  ),
);
