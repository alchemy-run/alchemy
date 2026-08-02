import { makeClient } from "@/SpacetimeDB/Client.ts";
import { parseLogLines } from "@/SpacetimeDB/Database.ts";
import type { SpacetimeDBCredentialsService } from "@/SpacetimeDB/Credentials.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const credentials: SpacetimeDBCredentialsService = {
  token: Redacted.make("test-token"),
  host: "https://maincloud.spacetimedb.com",
};

const mockHttp = (
  handler: (args: { method: string; url: string; body?: string }) => {
    status: number;
    body: unknown;
  },
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      let bodyText: string | undefined;
      try {
        const b = (request as { body?: { _tag?: string; body?: Uint8Array } })
          .body;
        if (b && b._tag === "Uint8Array" && b.body) {
          bodyText = new TextDecoder().decode(b.body);
        }
      } catch {
        /* ignore */
      }
      const result = handler({
        method: request.method,
        url: request.url,
        body: bodyText,
      });
      const text =
        typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body);
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, {
          status: result.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

describe("client ops", () => {
  it.effect("call posts JSON args to /call/:reducer", () =>
    Effect.gen(function* () {
      let seen = { url: "", body: "" };
      const client = makeClient(
        credentials,
        mockHttp(({ url, body }) => {
          seen = { url, body: body ?? "" };
          return { status: 200, body: null };
        }),
      );
      yield* client.call("my-db", "add_todo", [{ text: "hi" }]);
      expect(seen.url).toContain("/v1/database/my-db/call/add_todo");
      expect(seen.body).toContain("hi");
    }),
  );

  it.effect("sql posts the query body", () =>
    Effect.gen(function* () {
      const client = makeClient(
        credentials,
        mockHttp(() => ({
          status: 200,
          body: [{ schema: { elements: [] }, rows: [["a"]] }],
        })),
      );
      const result = yield* client.sql("my-db", "SELECT * FROM todo");
      expect(result).toHaveLength(1);
      expect(result[0]?.rows).toEqual([["a"]]);
    }),
  );

  it.effect("getLogs returns text", () =>
    Effect.gen(function* () {
      const client = makeClient(
        credentials,
        mockHttp(() => ({
          status: 200,
          body: "2025-01-13T12:00:00.000000Z  INFO: hello\n",
        })),
      );
      // getLogs expects text/plain; mock returns JSON-stringified body via
      // JSON.stringify of a string (quoted). Use raw text response:
      const textClient = makeClient(
        credentials,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response("2025-01-13T12:00:00.000000Z  INFO: hello\n", {
                status: 200,
              }),
            ),
          ),
        ),
      );
      const text = yield* textClient.getLogs("my-db", { numLines: 10 });
      expect(text).toContain("INFO: hello");
    }),
  );
});

describe("parseLogLines", () => {
  it("splits timestamped lines", () => {
    const lines = parseLogLines(
      "2025-01-13T12:00:00.000000Z  INFO: hello\nplain line\n",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.message).toBe("INFO: hello");
    expect(lines[0]?.timestamp.toISOString()).toContain("2025-01-13");
    expect(lines[1]?.message).toBe("plain line");
  });
});
