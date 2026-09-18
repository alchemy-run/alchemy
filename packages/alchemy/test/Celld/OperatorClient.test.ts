import { d1Scope, makeLocalFleetOperator } from "@/Celld/OperatorClient.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { createHash, createHmac } from "node:crypto";

const run = Effect.runPromise;

test(
  "generated D1 operations sign exact serialized bytes and seven peer headers",
  () =>
    run(
      Effect.gen(function* () {
        const key = yield* Effect.sync(() => new Uint8Array(32).fill(7));
        const calls: string[] = [];
        const nonces = new Set<string>();
        const httpClient = HttpClient.make((request) =>
          Effect.sync(() => {
            const headers = request.headers;
            expect(
              Object.keys(headers).filter((name) =>
                name.startsWith("x-cells-peer-"),
              ).length,
            ).toBe(7);
            expect(headers["x-cells-peer-version"]).toBe("5");
            expect(headers["x-cells-peer-source"]).toBe("alchemy");
            expect(headers["x-cells-peer-target"]).toBe("node-session-1");
            expect(headers["x-cells-peer-timestamp"]).toMatch(/^\d{13}$/);
            expect(headers["x-cells-peer-nonce"]).toMatch(/^[0-9a-f]{32}$/);
            expect(nonces.has(headers["x-cells-peer-nonce"]!)).toBe(false);
            nonces.add(headers["x-cells-peer-nonce"]!);
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag !== "Uint8Array")
              throw new Error("expected serialized body");
            const bodyHash = createHash("sha256")
              .update(request.body.body)
              .digest("hex");
            expect(headers["x-cells-peer-body-sha256"]).toBe(bodyHash);
            const url = new URL(request.url);
            expect(url.pathname).toBe("/runtime/__D1Database:abc");
            expect(url.search).toBe("?name=space+%2F%2B%3F");
            const canonical = [
              "cells-peer-request-v1",
              "5",
              "POST",
              `${url.pathname}${url.search}`,
              bodyHash,
              "alchemy",
              "node-session-1",
              headers["x-cells-peer-timestamp"],
              headers["x-cells-peer-nonce"],
            ].join("\n");
            expect(headers["x-cells-peer-signature"]).toBe(
              createHmac("sha256", key).update(canonical).digest("hex"),
            );
            const body = JSON.parse(
              new TextDecoder().decode(request.body.body),
            );
            expect(body.scope).toBeUndefined();
            expect(body.name).toBeUndefined();
            expect(body.peer_signature).toBeUndefined();
            calls.push(Object.keys(body)[0]!);
            const result = body.exec
              ? {
                  count: 1,
                  duration: 0.5,
                  results: [
                    {
                      columns: ["n"],
                      rows: [[null]],
                      meta: { preparedSql: body.exec.sql },
                    },
                  ],
                }
              : body.statements
                ? [{ columns: ["n"], rows: [[null]], meta: { changes: 0 } }]
                : { count: 1, duration: 0.25 };
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ result }),
            );
          }),
        );
        const operator = makeLocalFleetOperator({
          endpoint: "http://localhost:8123",
          target: "node-session-1",
          source: "alchemy",
          peerKey: Redacted.make(key),
          httpClient,
        });
        const address = { scope: "__D1Database:abc", name: "space /+?" };
        const exec = yield* operator.execD1(
          {},
          { ...address, exec: { sql: " SELECT '☃'; -- exact", rows: true } },
        );
        expect(exec.result.results?.[0]?.rows).toEqual([[null]]);
        expect(exec.result.results?.[0]?.meta).toEqual({
          preparedSql: " SELECT '☃'; -- exact",
        });
        const query = yield* operator.executeD1Statements(
          {},
          { ...address, statements: [{ sql: "SELECT ?", params: [null] }] },
        );
        expect(query.result[0]?.rows).toEqual([[null]]);
        yield* operator.migrateD1(
          {},
          {
            ...address,
            migrate: {
              name: "0001",
              table: "ledger",
              sql: "CREATE TABLE t(x);",
            },
          },
        );
        expect(calls).toEqual(["exec", "statements", "migrate"]);
      }),
    ),
  { timeout: 30_000 },
);

test(
  "operator errors do not replay unsafe mutations or expose request material",
  () =>
    run(
      Effect.gen(function* () {
        let calls = 0;
        const operator = makeLocalFleetOperator({
          endpoint: "http://localhost:8123",
          source: "alchemy",
          target: "node-1",
          peerKey: Redacted.make(
            yield* Effect.sync(() => new Uint8Array(32).fill(9)),
          ),
          httpClient: HttpClient.make((request) =>
            Effect.sync(() => {
              calls++;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "private SQL value" }, { status: 503 }),
              );
            }),
          ),
        });
        const outcome = yield* operator
          .migrateD1(
            {},
            {
              scope: "__D1Database:abc",
              migrate: { name: "one", sql: "INSERT INTO t VALUES ('secret')" },
            },
          )
          .pipe(Effect.result);
        expect(calls).toBe(1);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(outcome.failure._tag).toBe("Celld.OperatorError");
          expect(String(outcome.failure)).not.toContain("private SQL value");
          expect(JSON.stringify(outcome.failure)).not.toContain("secret");
        }
      }),
    ),
  { timeout: 30_000 },
);

test(
  "invalid peer configuration fails without dispatching an HTTP request",
  () =>
    run(
      Effect.gen(function* () {
        let calls = 0;
        const operator = makeLocalFleetOperator({
          endpoint: "http://localhost:8123",
          source: "..",
          target: "node-1",
          peerKey: Redacted.make(yield* Effect.sync(() => new Uint8Array(16))),
          httpClient: HttpClient.make(() =>
            Effect.sync(() => {
              calls++;
              throw new Error("must not dispatch");
            }),
          ),
        });
        const outcome = yield* operator
          .execD1({}, { scope: "__D1Database:abc", exec: { sql: "SELECT 1" } })
          .pipe(Effect.result);
        expect(Result.isFailure(outcome)).toBe(true);
        expect(calls).toBe(0);
      }),
    ),
  { timeout: 30_000 },
);

test("D1 scope follows the namespace hash and two HMAC rounds", () =>
  run(
    Effect.gen(function* () {
      const scope = yield* d1Scope("Db");
      const expected = yield* Effect.sync(() => {
        const key = createHash("sha256")
          .update("cells:v1:d1:__D1Database")
          .digest();
        const first = createHmac("sha256", key)
          .update("Db")
          .digest()
          .subarray(0, 16);
        return `__D1Database:${Buffer.from(first).toString("hex")}${createHmac("sha256", key).update(first).digest("hex").slice(0, 32)}`;
      });
      expect(scope).toBe(expected);
      expect(yield* d1Scope("Other")).not.toBe(scope);
    }),
  ));
