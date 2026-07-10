import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import VerifiedPermissionsTestFunctionLive, {
  VerifiedPermissionsTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "VerifiedPermissionsBindings",
);

const readinessPolicy = Schedule.exponential("500 millis").pipe(
  Schedule.both(Schedule.recurs(10)),
);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(6)),
      ),
    }),
  );

describe("VerifiedPermissions Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* VerifiedPermissionsTestFunction;
        }).pipe(Effect.provide(VerifiedPermissionsTestFunctionLive)),
      );
      baseUrl = functionUrl!.replace(/\/+$/, "");
      // wait for the fresh function URL to serve (AVP is eventually consistent
      // — policies take a moment to be evaluatable after CreatePolicy)
      yield* send(HttpClientRequest.get(`${baseUrl}/info`)).pipe(
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 60_000 });

  describe("IsAuthorized", () => {
    test.provider("allows alice to view a photo", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/authorize?user=alice`),
        ).pipe(
          Effect.retry({
            schedule: Schedule.spaced("3 seconds").pipe(
              Schedule.both(Schedule.recurs(10)),
            ),
          }),
        );
        const body = (yield* response.json) as { decision: string };
        expect(body.decision).toBe("ALLOW");
      }),
    );

    test.provider("denies bob (no matching permit policy)", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/authorize?user=bob`),
        );
        const body = (yield* response.json) as { decision: string };
        expect(body.decision).toBe("DENY");
      }),
    );
  });

  describe("BatchIsAuthorized", () => {
    test.provider("returns ALLOW for alice and DENY for bob", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/batch`),
        ).pipe(
          Effect.retry({
            schedule: Schedule.spaced("3 seconds").pipe(
              Schedule.both(Schedule.recurs(10)),
            ),
          }),
        );
        const body = (yield* response.json) as { decisions: string[] };
        expect(body.decisions).toEqual(["ALLOW", "DENY"]);
      }),
    );
  });
});
