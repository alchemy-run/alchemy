import * as Effect from "effect/Effect";
import { createServer, type Server } from "node:http";

export interface OtlpCollector {
  readonly server: Server;
  /** Base URL (`http://127.0.0.1:<port>`); append the OTLP signal path. */
  readonly url: string;
  /** Responses fully written to the client. */
  readonly completedRequests: { value: number };
  /** Received batches, including exports whose client disconnected. */
  readonly requests: Array<{
    body: string;
    completed: boolean;
    aborted: boolean;
  }>;
  /** Re-arm the response gate for subsequent matching batches. */
  readonly holdResponses: () => void;
  /** Acknowledge held batches and leave the gate open until re-armed. */
  readonly releaseResponses: () => void;
}

/**
 * Starts a local OTLP endpoint that records exports and completed responses.
 * Matching `holdResponse` batches wait for explicit release, so tests can
 * assert response/export ordering without timer races. The Node server is
 * a test adapter only.
 */
export const startOtlpCollector = (
  options: {
    holdResponse?: (body: string) => boolean;
  } = {},
) =>
  Effect.acquireRelease(
    Effect.callback<OtlpCollector, Error>((resume) => {
      const completedRequests = { value: 0 };
      const requests: OtlpCollector["requests"] = [];
      const pending = new Set<() => void>();
      let held = true;
      const holdResponses = () => {
        held = true;
      };
      const releaseResponses = () => {
        held = false;
        for (const send of pending) send();
        pending.clear();
      };
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.once("end", () => {
          const batch = { body, completed: false, aborted: false };
          requests.push(batch);
          const send = () => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"partialSuccess":{}}');
          };
          response.once("finish", () => {
            batch.completed = true;
            completedRequests.value += 1;
          });
          response.once("close", () => {
            batch.aborted = !batch.completed;
            pending.delete(send);
          });
          if (held && options.holdResponse?.(body)) {
            pending.add(send);
          } else {
            send();
          }
        });
      });
      const onError = (error: Error) => resume(Effect.fail(error));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(
            Effect.fail(new Error("OTLP test collector address unavailable")),
          );
          return;
        }
        resume(
          Effect.succeed({
            server,
            completedRequests,
            requests,
            holdResponses,
            releaseResponses,
            url: `http://127.0.0.1:${address.port}`,
          }),
        );
      });
      return Effect.sync(() => server.close());
    }),
    ({ server, releaseResponses }) =>
      Effect.callback<void, Error>((resume) => {
        releaseResponses();
        server.close((error) =>
          resume(error === undefined ? Effect.void : Effect.fail(error)),
        );
      }).pipe(Effect.orDie),
  );
