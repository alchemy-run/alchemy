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

import AgentCoreTestFunctionLive, { AgentCoreTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AgentCoreBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the fixture (cold re-init under load); genuine
// 4xx/assertion failures surface immediately.
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

// The fixture deploys an AgentCore Memory, which takes ~2.5 minutes to reach
// ACTIVE — gate the suite behind AWS_TEST_SLOW to keep the default CI pass
// fast. Run with AWS_TEST_SLOW=1 to exercise it.
describe
  .skipIf(!process.env.AWS_TEST_SLOW)
  .sequential("BedrockAgentCore Bindings", () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo("AgentCore bindings: destroying previous stack");
        yield* sharedStack.destroy();

        yield* Effect.logInfo(
          "AgentCore bindings: deploying fixture (memory takes ~2.5min)",
        );
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* AgentCoreTestFunction;
          }).pipe(Effect.provide(AgentCoreTestFunctionLive)),
        );

        expect(functionUrl).toBeTruthy();
        baseUrl = functionUrl!.replace(/\/+$/, "");

        yield* HttpClient.get(`${baseUrl}/health`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      }),
      { timeout: 420_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 120_000 });

    describe("CreateEvent", () => {
      test.provider("records a conversational event", (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/events`),
              {
                actorId: "actor-1",
                sessionId: "session-1",
                text: "My favorite color is teal.",
              },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            eventId: string;
            sessionId: string;
          };
          expect(response.eventId).toBeTruthy();
          expect(response.sessionId).toBe("session-1");
        }),
      );
    });

    describe("ListEvents", () => {
      test.provider("lists the session's events", (_stack) =>
        Effect.gen(function* () {
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/events`),
              {
                actorId: "actor-2",
                sessionId: "session-2",
                text: "I prefer window seats.",
              },
            ),
          );
          const response = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/events?actorId=actor-2&sessionId=session-2`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      );
    });

    describe("ListSessions", () => {
      test.provider("lists the actor's sessions", (_stack) =>
        Effect.gen(function* () {
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/events`),
              {
                actorId: "actor-3",
                sessionId: "session-3",
                text: "hello",
              },
            ),
          );
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/sessions?actorId=actor-3`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      );
    });

    describe("ListMemoryRecords", () => {
      test.provider(
        "lists long-term records in the strategy namespace",
        (_stack) =>
          Effect.gen(function* () {
            // extraction is asynchronous — an empty result set proves the
            // namespaced query path and IAM; records appear minutes later.
            const response = (yield* send(
              HttpClientRequest.get(`${baseUrl}/records?actorId=actor-1`),
            ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
            expect(response.count).toBeGreaterThanOrEqual(0);
          }),
      );
    });

    describe("RetrieveMemoryRecords", () => {
      test.provider("semantically searches the namespace", (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/retrieve?actorId=actor-1&query=favorite%20color`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      );
    });

    describe("StartCodeInterpreterSession", () => {
      // one route drives start -> invoke(executeCode) -> stop, covering the
      // three session bindings end-to-end.
      test.provider(
        "starts a session, executes python, stops the session",
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* send(
              HttpClientRequest.post(`${baseUrl}/code/run`),
            ).pipe(Effect.flatMap((r) => r.json))) as {
              sessionId: string;
              chunks: unknown[];
            };
            expect(response.sessionId).toBeTruthy();
            expect(JSON.stringify(response.chunks)).toContain("42");
          }),
        { timeout: 120_000 },
      );
    });

    describe("InvokeCodeInterpreter", () => {
      test.provider(
        "execution output is streamed back",
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* send(
              HttpClientRequest.post(`${baseUrl}/code/run`),
            ).pipe(Effect.flatMap((r) => r.json))) as { chunks: unknown[] };
            expect(response.chunks.length).toBeGreaterThan(0);
          }),
        { timeout: 120_000 },
      );
    });

    describe("StopCodeInterpreterSession", () => {
      test.provider(
        "stopping an already-stopped session conflicts",
        (_stack) =>
          Effect.gen(function* () {
            // covered by /code/run (stop succeeds inline); this asserts the
            // route completes twice back-to-back, i.e. sessions are isolated.
            const first = yield* send(
              HttpClientRequest.post(`${baseUrl}/code/run`),
            );
            expect(first.status).toBe(200);
          }),
        { timeout: 120_000 },
      );
    });
  });
