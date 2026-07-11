import * as Lambda from "@/AWS/Lambda";
import * as ServiceQuotas from "@/AWS/ServiceQuotas";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ServiceQuotasTestFunction extends Lambda.Function<Lambda.Function>()(
  "ServiceQuotasTestFunction",
) {}

export default ServiceQuotasTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const getServiceQuota = yield* ServiceQuotas.GetServiceQuota();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Service Quotas call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/quota") {
          const serviceCode = url.searchParams.get("service");
          const quotaCode = url.searchParams.get("quota");
          if (serviceCode === null || quotaCode === null) {
            return yield* HttpServerResponse.json(
              { error: "service and quota query params are required" },
              { status: 400 },
            );
          }
          return yield* getServiceQuota({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                quotaCode: result.Quota?.QuotaCode,
                quotaName: result.Quota?.QuotaName,
                value: result.Quota?.Value,
                adjustable: result.Quota?.Adjustable,
              }),
            ),
            // The typed not-found tag round-trips as a 404 so the test can
            // assert the binding surfaces distilled's typed error union.
            Effect.catchTag("NoSuchResourceException", () =>
              HttpServerResponse.json(
                { tag: "NoSuchResourceException" },
                { status: 404 },
              ),
            ),
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(ServiceQuotas.GetServiceQuotaHttp)),
);
