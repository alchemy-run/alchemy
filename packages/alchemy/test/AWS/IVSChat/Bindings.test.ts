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

import IVSChatTestFunctionLive, {
  IVSChatTestFunction,
} from "./fixtures/handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IVSChatBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

const post = (path: string) =>
  HttpClient.execute(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
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
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe("IVSChat Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "IVSChat test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IVSChat test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IVSChatTestFunction;
        }).pipe(Effect.provide(IVSChatTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `IVSChat test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IVSChat test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("IVSChat.CreateChatToken", () => {
    test.provider(
      "mints a redacted chat token honoring sessionDuration",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/token").pipe(
            Effect.flatMap((r) => r.json),
          )) as {
            tokenLength: number;
            tokenIsRedacted: boolean;
            tokenExpirationTime?: string;
            sessionExpirationTime?: string;
          };

          expect(response.tokenLength).toBeGreaterThan(0);
          // SensitiveString in distilled decodes to a Redacted value.
          expect(response.tokenIsRedacted).toBe(true);
          expect(response.tokenExpirationTime).toBeTruthy();
          expect(response.sessionExpirationTime).toBeTruthy();

          // sessionDuration: "30 minutes" must reach the wire as
          // sessionDurationInMinutes: 30 (the API default is 60).
          const sessionMinutes =
            (new Date(response.sessionExpirationTime!).getTime() - Date.now()) /
            60_000;
          expect(sessionMinutes).toBeGreaterThan(20);
          expect(sessionMinutes).toBeLessThan(40);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.SendEvent", () => {
    test.provider(
      "broadcasts an application event to the room",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/send-event").pipe(
            Effect.flatMap((r) => r.json),
          )) as { id?: string };

          expect(typeof response.id).toBe("string");
          expect(response.id!.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.DeleteMessage", () => {
    test.provider(
      "broadcasts a DELETEMESSAGE moderation event",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/delete-message").pipe(
            Effect.flatMap((r) => r.json),
          )) as { deleted?: string };

          expect(typeof response.deleted).toBe("string");
          expect(response.deleted!.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.DisconnectUser", () => {
    test.provider(
      "disconnects a user's room connections",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/disconnect-user").pipe(
            Effect.flatMap((r) => r.json),
          )) as { ok?: boolean };

          expect(response.ok).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });
});
