import * as AgentCore from "@/AWS/BedrockAgentCore";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class AgentCoreTestFunction extends Lambda.Function<Lambda.Function>()(
  "AgentCoreTestFunction",
) {}

export default AgentCoreTestFunction.make(
  {
    main,
    url: true,
    // code interpreter session start + execution can take >3s (the default)
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const memory = yield* AgentCore.Memory("TestMemory", {
      eventExpiryDuration: 7,
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: "facts",
            namespaces: ["facts/{actorId}"],
          },
        },
      ],
    });
    const codeInterpreter = yield* AgentCore.CodeInterpreter(
      "TestInterpreter",
      {},
    );

    const createEvent = yield* AgentCore.CreateEvent(memory);
    const listEvents = yield* AgentCore.ListEvents(memory);
    const listSessions = yield* AgentCore.ListSessions(memory);
    const listMemoryRecords = yield* AgentCore.ListMemoryRecords(memory);
    const retrieveMemoryRecords =
      yield* AgentCore.RetrieveMemoryRecords(memory);
    const startSession =
      yield* AgentCore.StartCodeInterpreterSession(codeInterpreter);
    const invokeCodeInterpreter =
      yield* AgentCore.InvokeCodeInterpreter(codeInterpreter);
    const stopSession =
      yield* AgentCore.StopCodeInterpreterSession(codeInterpreter);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/events") {
          const body = (yield* request.json) as unknown as {
            actorId: string;
            sessionId: string;
            text: string;
          };
          const result = yield* createEvent({
            actorId: body.actorId,
            sessionId: body.sessionId,
            eventTimestamp: new Date(),
            payload: [
              {
                conversational: {
                  role: "USER",
                  content: { text: body.text },
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            eventId: result.event.eventId,
            sessionId: result.event.sessionId,
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* listEvents({
            actorId: url.searchParams.get("actorId")!,
            sessionId: url.searchParams.get("sessionId")!,
          });
          return yield* HttpServerResponse.json({
            count: result.events.length,
          });
        }

        if (request.method === "GET" && pathname === "/sessions") {
          const result = yield* listSessions({
            actorId: url.searchParams.get("actorId")!,
          });
          return yield* HttpServerResponse.json({
            count: result.sessionSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/records") {
          const result = yield* listMemoryRecords({
            namespace: `facts/${url.searchParams.get("actorId")}`,
          });
          return yield* HttpServerResponse.json({
            count: result.memoryRecordSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/retrieve") {
          const result = yield* retrieveMemoryRecords({
            namespace: `facts/${url.searchParams.get("actorId")}`,
            searchCriteria: {
              searchQuery: url.searchParams.get("query") ?? "anything",
              topK: 3,
            },
          });
          return yield* HttpServerResponse.json({
            count: result.memoryRecordSummaries.length,
          });
        }

        if (request.method === "POST" && pathname === "/code/run") {
          const session = yield* startSession({
            sessionTimeoutSeconds: 300,
          });
          const result = yield* invokeCodeInterpreter({
            sessionId: session.sessionId,
            name: "executeCode",
            arguments: { language: "python", code: "print(21 * 2)" },
          });
          const chunks = yield* Stream.runCollect(result.stream);
          yield* stopSession({ sessionId: session.sessionId });
          return yield* HttpServerResponse.json({
            sessionId: session.sessionId,
            chunks: Array.from(chunks),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AgentCore.CreateEventHttp,
        AgentCore.ListEventsHttp,
        AgentCore.ListSessionsHttp,
        AgentCore.ListMemoryRecordsHttp,
        AgentCore.RetrieveMemoryRecordsHttp,
        AgentCore.StartCodeInterpreterSessionHttp,
        AgentCore.InvokeCodeInterpreterHttp,
        AgentCore.StopCodeInterpreterSessionHttp,
      ),
    ),
  ),
);
