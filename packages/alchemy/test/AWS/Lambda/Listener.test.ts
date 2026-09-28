import * as AWS from "@/AWS/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ListenerProbe from "./fixtures/listener-probe.ts";

const { test } = Test.make({ providers: AWS.providers() });

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  status: number;
}> {}

const ProbeResponse = Schema.Struct({
  sandbox: Schema.String,
  initialized: Schema.Number,
  finalized: Schema.Number,
  instanceFinalized: Schema.Boolean,
  request: Schema.Number,
  requestBuild: Schema.Number,
  freshScope: Schema.Boolean,
  distinctInitScope: Schema.Boolean,
  requestId: Schema.String,
  config: Schema.String,
  initConfig: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
  region: Schema.optionalKey(Schema.String),
  initHasHandlerContext: Schema.optionalKey(Schema.Boolean),
});

test.provider(
  "listener registration preserves application services and runtime scopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const environment = yield* AWS.AWSEnvironment.current;
      const fn = yield* stack.deploy(ListenerProbe);
      const url = fn.functionUrl!.replace(/\/$/, "");
      const client = yield* HttpClient.HttpClient;
      const previous = new Map<string, typeof ProbeResponse.Type>();
      const requestIds = new Set<string>();
      let reusedSandbox = false;

      for (const route of [
        "deferred",
        "direct",
        "serve",
        "deferred",
        "direct",
        "serve",
      ]) {
        const response = yield* client.get(`${url}/${route}`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new FunctionNotReady({ status: response.status })),
          ),
          Effect.retry({
            while: (error) => error._tag === "FunctionNotReady",
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
          }),
        );
        const body = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ProbeResponse)),
        );
        expect(body.config).toBe(route);
        expect(body.initialized).toBe(1);
        expect(body.instanceFinalized).toBe(false);
        expect(body.freshScope).toBe(true);
        expect(body.distinctInitScope).toBe(true);
        expect(body.requestId).toBeTruthy();
        expect(requestIds.has(body.requestId)).toBe(false);
        requestIds.add(body.requestId);
        expect(body.requestBuild).toBe(body.request);
        expect(body.finalized).toBe(body.request - 1);
        const prior = previous.get(body.sandbox);
        if (prior) {
          reusedSandbox = true;
          expect(body.request).toBe(prior.request + 1);
        }
        previous.set(body.sandbox, body);
        if (route === "deferred") {
          expect(body.initConfig).toBe("deferred");
          expect(body.stage).toBe(stack.stage);
          expect(body.accountId).toBe(environment.accountId);
          expect(body.region).toBe(environment.region);
          expect(body.initHasHandlerContext).toBe(false);
        }
      }
      expect(reusedSandbox).toBe(true);
      const failure = yield* client.get(`${url}/fail`);
      expect(failure.status).toBeGreaterThanOrEqual(500);
      const recovered = yield* client.get(`${url}/deferred`);
      expect(recovered.status).toBe(200);
      const afterFailure = yield* recovered.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ProbeResponse)),
      );
      expect(afterFailure.finalized).toBe(afterFailure.request - 1);
      expect(afterFailure.instanceFinalized).toBe(false);
      expect(afterFailure.freshScope).toBe(true);
      expect(afterFailure.distinctInitScope).toBe(true);
      expect(afterFailure.config).toBe("deferred");
      yield* stack.destroy();
      const deleted = yield* Lambda.getFunction({
        FunctionName: fn.functionName,
      }).pipe(
        Effect.as(false),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(true),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
          until: (gone) => gone,
        }),
      );
      expect(deleted).toBe(true);
    }),
  { timeout: 120_000 },
);
