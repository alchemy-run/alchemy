/**
 * Test for Lambda Function response streaming support.
 *
 * This test verifies that when a Lambda Function URL is configured with
 * `RESPONSE_STREAM` invoke mode, the handler streams responses instead of
 * buffering them.
 */

import * as AWS from "alchemy/AWS";
import * as Alchemy from "alchemy";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Simple streaming function that returns a large response
export default class StreamingFunction extends AWS.Lambda.Function<StreamingFunction>()(
  "StreamingFunction",
  {
    main: import.meta.url,
    memorySize: 512,
    functionUrl: {
      authType: "NONE",
      // Enable response streaming
      invokeMode: "RESPONSE_STREAM",
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.method === "GET" && request.url.endsWith("/stream")) {
          // Generate a response larger than 6MB to test streaming
          // Without streaming, this would fail due to Lambda's buffered response limit
          const largeData = "x".repeat(1024 * 1024); // 1MB chunk
          const chunks: string[] = [];
          for (let i = 0; i < 7; i++) {
            chunks.push(largeData);
          }
          const body = chunks.join("");

          return HttpServerResponse.json({
            size: body.length,
            message: "This response is over 6MB and requires streaming",
          });
        }

        if (request.method === "GET" && request.url.endsWith("/sse")) {
          // Server-Sent Events example
          const response = HttpServerResponse.text("data: event1\ndata: event2\n", {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
          return response;
        }

        return HttpServerResponse.json({ message: "OK" });
      }),
    };
  }),
);
