import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/prisma/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Prisma.providers()),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface Widget {
  id: number;
  name: string;
}

/**
 * Fresh workers.dev URLs can serve a placeholder page with HTTP 200 while
 * the route propagates, so readiness is anchored on the response body
 * parsing as our JSON shape — never on the status code alone.
 */
class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total wait so a genuine failure surfaces
// fast instead of riding the vitest timeout.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(45)]);

const parseJson = (status: number, body: string) =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: () => new NotReady({ status, body }),
  });

const untilReady = <A, E, R>(eff: Effect.Effect<A, E | NotReady, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e): e is NotReady => e instanceof NotReady,
      schedule: ready,
    }),
  );

/** POST /widgets until the created row echoes back with our marker name. */
const createWidget = (base: string, name: string) =>
  untilReady(
    HttpClient.execute(
      HttpClientRequest.post(`${base}/widgets`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ name }),
      ),
    ).pipe(
      Effect.flatMap((res) =>
        res.text.pipe(Effect.map((body) => [res.status, body] as const)),
      ),
      Effect.flatMap(([status, body]) =>
        parseJson(status, body).pipe(
          Effect.flatMap((parsed) => {
            const widget = (parsed as { widget?: Widget }).widget;
            return widget !== undefined &&
              widget.name === name &&
              typeof widget.id === "number"
              ? Effect.succeed(widget)
              : Effect.fail(new NotReady({ status, body }));
          }),
        ),
      ),
    ),
  );

/** GET /widgets until the list contains the given widget (D1 reads are
 * eventually consistent across edge locations). */
const listUntilContains = (base: string, widget: Widget) =>
  untilReady(
    HttpClient.get(`${base}/widgets`).pipe(
      Effect.flatMap((res) =>
        res.text.pipe(Effect.map((body) => [res.status, body] as const)),
      ),
      Effect.flatMap(([status, body]) =>
        parseJson(status, body).pipe(
          Effect.flatMap((parsed) => {
            const widgets = (parsed as { widgets?: Widget[] }).widgets;
            return widgets?.some(
              (w) => w.id === widget.id && w.name === widget.name,
            )
              ? Effect.succeed(widgets)
              : Effect.fail(new NotReady({ status, body }));
          }),
        ),
      ),
    ),
  );

/**
 * End-to-end: `Prisma.Schema` generates migration SQL on deploy,
 * `Cloudflare.D1.Database` applies it via `migrationsDir`, and the deployed
 * Worker round-trips rows through the generated Prisma client
 * (`Prisma.d1(PrismaClient, db.raw)` over `@prisma/adapter-d1`).
 *
 * The stack lives in `fixtures/prisma/stack.ts` so it can also be inspected
 * directly, e.g. `alchemy tail --stage test ./test/Cloudflare/D1/fixtures/prisma/stack.ts`.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

test(
  "worker round-trips a widget through Prisma over D1",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // The migration (CREATE TABLE Widget) was applied by the deploy itself —
    // no /init route: a successful create proves the table exists.
    const created = yield* createWidget(url, "gizmo");
    expect(created.name).toBe("gizmo");
    expect(typeof created.id).toBe("number");

    const widgets = yield* listUntilContains(url, created);
    expect(widgets.map((w) => w.name)).toContain("gizmo");
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);
