import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/prisma-worker/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Neon.providers(),
    Prisma.providers(),
  ),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface WidgetResponse {
  ok: boolean;
  widget: { id: number; name: string } | null;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  reason: string;
}> {}

/**
 * End-to-end guard for the Prisma runtime integration: deploy a
 * Prisma.Schema (migration SQL generated from `schema.prisma` on deploy), a
 * Neon project + branch migrated from that SQL, a Hyperdrive fronting the
 * branch, and a Worker that queries through the generated Prisma client via
 * `Prisma.postgres`. Insert over HTTP, read back, and assert values.
 *
 * Fresh workers.dev URLs can serve a placeholder page with HTTP 200, so
 * every request is anchored on the response CONTENT (the `ok`/`widget` JSON
 * markers), never on bare status.
 */
test(
  "deployed Worker queries Neon through Prisma over Hyperdrive",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
    const baseUrl = url.replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;

    // Parse the body and require the JSON marker — a placeholder page or a
    // cold edge serves non-JSON (or JSON without `ok`), which retries.
    const call = (method: "GET" | "PUT", path: string) =>
      Effect.gen(function* () {
        const res =
          method === "PUT"
            ? yield* client.put(`${baseUrl}${path}`)
            : yield* client.get(`${baseUrl}${path}`);
        const text = yield* res.text;
        const body = yield* Effect.try({
          try: () => JSON.parse(text) as WidgetResponse,
          catch: () =>
            new WorkerNotReady({
              status: res.status,
              reason: `non-JSON body: ${text.slice(0, 100)}`,
            }),
        });
        if (body.ok !== true) {
          return yield* Effect.fail(
            new WorkerNotReady({
              status: res.status,
              reason: `missing ok marker: ${text.slice(0, 100)}`,
            }),
          );
        }
        return body;
      }).pipe(
        Effect.retry({
          while: (e): boolean => e._tag === "WorkerNotReady",
          schedule: Schedule.max([
            Schedule.exponential("500 millis"),
            Schedule.recurs(10),
          ]),
        }),
      );

    // Insert (upsert, so re-runs against a kept deployment stay green).
    const inserted = yield* call("PUT", "/widgets/gizmo");
    expect(inserted.widget).toMatchObject({ name: "gizmo" });
    expect(inserted.widget?.id).toBeTypeOf("number");

    // Read back in a separate event — Hyperdrive caching is disabled, so
    // the read must observe the write.
    const read = yield* call("GET", "/widgets/gizmo");
    expect(read.widget).toMatchObject({ name: "gizmo" });
    expect(read.widget?.id).toBe(inserted.widget?.id);

    // A missing widget resolves to null rather than failing.
    const missing = yield* call("GET", "/widgets/no-such-widget");
    expect(missing.widget).toBeNull();

    // Two more sequential events: each event builds (and closes) its own
    // pg pool on its own scope — the second must never observe the first
    // event's closed pool ("Cannot use a pool after calling end on the
    // pool") or its request context.
    const again1 = yield* call("GET", "/widgets/gizmo");
    const again2 = yield* call("GET", "/widgets/gizmo");
    expect(again1.widget?.name).toBe("gizmo");
    expect(again2.widget?.name).toBe("gizmo");
  }).pipe(logLevel),
  { timeout: 600_000 },
);
