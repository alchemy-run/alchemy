import * as Lambda from "@/AWS/Lambda";
import * as Pricing from "@/AWS/Pricing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class PricingTestFunction extends Lambda.Function<Lambda.Function>()(
  "PricingTestFunction",
) {}

export default PricingTestFunction.make(
  {
    main,
    url: true,
    // Price List queries return large JSON documents; the default 3s Lambda
    // timeout intermittently trips under cold start + big responses.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const getProducts = yield* Pricing.GetProducts();
    const describeServices = yield* Pricing.DescribeServices();
    const getAttributeValues = yield* Pricing.GetAttributeValues();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Pricing call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/products") {
          const result = yield* getProducts({
            ServiceCode: "AmazonEC2",
            Filters: [
              { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
              {
                Type: "TERM_MATCH",
                Field: "location",
                Value: "US East (N. Virginia)",
              },
              { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
            ],
            MaxResults: 5,
          });
          const priceList = result.PriceList ?? [];
          const first =
            priceList.length > 0
              ? (JSON.parse(priceList[0]) as {
                  product?: {
                    attributes?: {
                      servicecode?: string;
                      instanceType?: string;
                    };
                  };
                })
              : undefined;
          return yield* HttpServerResponse.json({
            count: priceList.length,
            formatVersion: result.FormatVersion,
            firstServiceCode: first?.product?.attributes?.servicecode,
            firstInstanceType: first?.product?.attributes?.instanceType,
          });
        }

        if (request.method === "GET" && pathname === "/services") {
          const result = yield* describeServices({
            ServiceCode: "AmazonEC2",
          });
          return yield* HttpServerResponse.json({
            services: (result.Services ?? []).map((service) => ({
              serviceCode: service.ServiceCode,
              attributeNameCount: (service.AttributeNames ?? []).length,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/attribute-values") {
          const result = yield* getAttributeValues({
            ServiceCode: "AmazonEC2",
            AttributeName: "volumeType",
            MaxResults: 25,
          });
          return yield* HttpServerResponse.json({
            values: (result.AttributeValues ?? [])
              .map((attribute) => attribute.Value)
              .filter((value) => value !== undefined),
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
        Pricing.GetProductsHttp,
        Pricing.DescribeServicesHttp,
        Pricing.GetAttributeValuesHttp,
      ),
    ),
  ),
);
