import * as Lambda from "@/AWS/Lambda";
import * as SageMaker from "@/AWS/SageMaker";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class SageMakerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SageMakerTestFunction",
) {}

export default SageMakerTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const featureGroup = yield* SageMaker.FeatureGroup("BindingsFeatures", {
      recordIdentifierFeatureName: "user_id",
      eventTimeFeatureName: "event_time",
      featureDefinitions: [
        { FeatureName: "user_id", FeatureType: "String" },
        { FeatureName: "event_time", FeatureType: "String" },
        { FeatureName: "clicks", FeatureType: "Integral" },
      ],
      onlineStoreConfig: { EnableOnlineStore: true },
    });

    const putRecord = yield* SageMaker.PutRecord(featureGroup);
    const getRecord = yield* SageMaker.GetRecord(featureGroup);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/put-record") {
          const body = (yield* request.json) as unknown as {
            userId: string;
            clicks: number;
          };
          yield* putRecord({
            Record: [
              { FeatureName: "user_id", ValueAsString: body.userId },
              {
                FeatureName: "event_time",
                ValueAsString: new Date().toISOString(),
              },
              { FeatureName: "clicks", ValueAsString: String(body.clicks) },
            ],
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "GET" && pathname === "/get-record") {
          const userId = url.searchParams.get("userId") ?? "";
          const result = yield* getRecord({
            RecordIdentifierValueAsString: userId,
          });
          return yield* HttpServerResponse.json({
            record: result.Record ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SageMaker.PutRecordHttp, SageMaker.GetRecordHttp),
    ),
  ),
);
