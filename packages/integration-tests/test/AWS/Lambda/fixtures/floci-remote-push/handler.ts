import * as ApiGateway from "@alchemy.run/aws/ApiGateway";
import * as EventBridge from "@alchemy.run/aws/EventBridge";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import * as Alchemy from "alchemy";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * A Lambda emulated by floci under `alchemy dev`, invoked by push sources in
 * the real cloud: a REST API, whose responses travel back through the dev
 * stub, and a custom EventBridge bus, whose events the handler records in
 * the real bucket.
 *
 * Does not `yield*` the API's outputs: the API settles only after its
 * methods, which reference this Function (see the REST API event-source
 * fixture). The test finds the API by its tags.
 */
export class RemotePushFunction extends Lambda.Function<RemotePushFunction>()(
  "RemotePushFunction",
) {}

export default RemotePushFunction.make(
  { main: import.meta.url, functionUrl: true, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("RemotePushBucket", { forceDestroy: true }).pipe(
      Alchemy.remote(),
    );
    const bus = yield* EventBridge.EventBus("RemotePushBus", {}).pipe(Alchemy.remote());
    const api = yield* ApiGateway.RestApi("RemotePushApi", {
      endpointConfiguration: { types: ["REGIONAL"] },
    }).pipe(Alchemy.remote());
    const putObject = yield* S3.PutObject(bucket);
    const bucketName = yield* bucket.bucketName;
    const busName = yield* bus.eventBusName;

    yield* ApiGateway.onRestApiRoute(api, { path: "/hello", httpMethod: "GET" }, (event) =>
      Effect.succeed({
        statusCode: 201,
        headers: { "content-type": "application/json", "x-served-by": "floci" },
        body: JSON.stringify({ path: event.path, name: event.queryStringParameters?.name }),
      }),
    );
    yield* ApiGateway.onRestApiRoute(api, { path: "/boom", httpMethod: "GET" }, () =>
      Effect.die(new Error("boom from floci")),
    );

    yield* EventBridge.consumeBusEvents(
      bus,
      { source: ["alchemy.test"] },
      (events: Stream.Stream<EventBridge.EventRecord<{ id: string }>>) =>
        events.pipe(
          Stream.runForEach((event) =>
            putObject({
              Key: `bus/${event.detail.id}`,
              Body: event["detail-type"],
            }),
          ),
          Effect.orDie,
        ),
    );

    const deployment = yield* ApiGateway.Deployment("RemotePushDeployment", {
      restApi: api,
    }).pipe(Alchemy.remote());
    yield* ApiGateway.Stage("RemotePushStage", {
      restApi: api,
      stageName: "test",
      deploymentId: deployment.deploymentId,
    }).pipe(Alchemy.remote());

    return {
      fetch: Effect.gen(function* () {
        yield* HttpServerRequest;
        return yield* HttpServerResponse.json({
          bucketName: yield* bucketName,
          busName: yield* busName,
        });
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Lambda.RestApiEventSource, Lambda.EventSource, S3.PutObjectHttp)),
  ),
);
