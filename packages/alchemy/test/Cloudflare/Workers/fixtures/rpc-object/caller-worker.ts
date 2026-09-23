import * as Cloudflare from "@/Cloudflare";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RpcObjectTarget, RpcObjectTargetLive } from "./object.ts";
import { RpcObjectStatsWorker } from "./stats-worker.ts";
import { RpcObjectTargetWorker } from "./target-worker.ts";

class CallerRejected extends Data.TaggedError("CallerRejected")<{}> {}

const failure = (exit: Exit.Exit<unknown, unknown>) => ({
  failed: Exit.isFailure(exit),
  interrupted: Exit.hasInterrupts(exit),
  diagnostic: Exit.isFailure(exit)
    ? `${Cause.pretty(exit.cause)}\n${JSON.stringify(
        exit.cause.reasons,
        (_key, value) =>
          value instanceof Error
            ? { ...value, name: value.name, message: value.message }
            : value,
      )}`
    : "",
});

const normalizeStreamValue = (
  value: unknown,
  seen = new Map<object, string>(),
  path = "$",
): unknown => {
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "bigint")
    return { type: "bigint", value: value.toString() };
  if (typeof value === "number" && Number.isNaN(value)) return { type: "NaN" };
  if (typeof value !== "object" || value === null) return value;
  const previous = seen.get(value);
  if (previous !== undefined) return { $ref: previous };
  seen.set(value, path);
  if (value instanceof Date)
    return { type: "Date", value: value.toISOString() };
  if (value instanceof Map)
    return {
      type: "Map",
      entries: Array.from(value, ([key, item], index) => [
        normalizeStreamValue(key, seen, `${path}.keys.${index}`),
        normalizeStreamValue(item, seen, `${path}.values.${index}`),
      ]),
    };
  if (value instanceof Set)
    return {
      type: "Set",
      values: Array.from(value, (item, index) =>
        normalizeStreamValue(item, seen, `${path}.${index}`),
      ),
    };
  if (value instanceof Uint8Array)
    return { type: "Uint8Array", values: Array.from(value) };
  if (value instanceof Uint16Array)
    return { type: "Uint16Array", values: Array.from(value) };
  if (Array.isArray(value))
    return value.map((item, index) =>
      normalizeStreamValue(item, seen, `${path}.${index}`),
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeStreamValue(item, seen, `${path}.${key}`),
    ]),
  );
};

export default class RpcObjectCaller extends Cloudflare.Worker<RpcObjectCaller>()(
  "RpcObjectCaller",
  Effect.gen(function* () {
    const legacy = yield* Cloudflare.Worker("RpcObjectLegacyWorker", {
      main: `${import.meta.dirname}/legacy-worker.ts`,
    });
    return {
      main: import.meta.url,
      env: {
        LegacyWorker: Cloudflare.WorkerEntrypoint(legacy, {
          entrypoint: "LegacyWorker",
        }),
        LegacyObject: Cloudflare.WorkerEntrypoint(legacy, {
          entrypoint: "LegacyObject",
        }),
      },
    };
  }),
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Workers.bindWorker(RpcObjectTargetWorker);
    const objects = yield* RpcObjectTarget;
    const stats = yield* Cloudflare.Workers.bindWorker(RpcObjectStatsWorker);

    const events = (id: string) =>
      stats.read(id).pipe(Effect.map((rows) => rows.map((row) => row.event)));
    const observed = Effect.fn(function* (id: string, event: string) {
      const rows = yield* events(id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          times: 8,
          until: (rows) => rows.includes(event),
        }),
      );
      if (!rows.includes(event)) {
        return yield* Effect.fail(
          new Error(`Missing ${event}: ${JSON.stringify(rows)}`),
        );
      }
      return rows;
    });

    const run = Effect.fn(function* (
      transport: "worker" | "do",
      scenario: string,
      id: string,
    ) {
      const target = transport === "worker" ? worker : objects.getByName(id);

      if (scenario === "legacy") {
        const environment = yield* Cloudflare.WorkerEnvironment;
        const legacy = Cloudflare.makeRpcStub<{
          echo(value: string): Effect.Effect<string>;
          fail(): Effect.Effect<never>;
        }>(
          environment[transport === "worker" ? "LegacyWorker" : "LegacyObject"],
          {
            invocations: true,
          },
        );
        return {
          value: yield* legacy.echo(id),
          failure: failure(yield* legacy.fail().pipe(Effect.exit)),
        };
      }

      if (scenario === "backing-buffers") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          return yield* object.backingBuffers().pipe(
            Stream.runFold(
              () => ({ count: 0, sum: 0 }),
              (total, view) => ({
                count: total.count + 1,
                sum: total.sum + view[0],
              }),
            ),
          );
        }).pipe(Effect.scoped);
      }

      if (scenario === "pure") {
        // The factory has no Scope requirement; the Worker event owns its stub.
        const object = yield* target.pure();
        const literal: "generic" = yield* object.echo("generic" as const);
        const number: number = yield* object.select(
          { count: 42, label: "answer" },
          "count",
        );
        const label: string = yield* object.select(
          { count: 42, label: "answer" },
          "label",
        );
        const nested = yield* object.echo({
          kind: "record",
          values: [1, 2, 3],
        } as const);
        return { literal, number, label, nested };
      }

      if (scenario === "roundtrip") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const scalar = yield* object.echo({
            text: "hello 🦊",
            number: 42.5,
            boolean: false,
            null: null,
            undefined: undefined,
            bigint: 9007199254740993n,
            nan: NaN,
            positiveInfinity: Infinity,
            negativeInfinity: -Infinity,
            negativeZero: -0,
          });
          const date = yield* object.echo(new Date("2026-09-20T12:34:56.789Z"));
          const map = yield* object.echo(
            new Map([
              ["one", { value: 1 }],
              ["two", { value: 2 }],
            ]),
          );
          const set = yield* object.echo(new Set(["alpha", "beta"]));
          const regexp = yield* object.echo(/hello\s+(world)/gi);
          const error = yield* object.echo(
            new TypeError("data error, not a failed call"),
          );
          const buffer = yield* object.echo(
            new Uint8Array([0, 255, 17, 42]).buffer,
          );
          const typed = yield* object.echo(new Uint16Array([0, 256, 65535]));
          const topNull = yield* object.echo(null);
          const topUndefined = yield* object.echo(undefined);
          const topBigint = yield* object.echo(1234567890123456789n);
          const literal: "correlated" = yield* object.echo(
            "correlated" as const,
          );
          const selected: number = yield* object.select(
            { name: "item", count: 7 },
            "count",
          );
          return {
            scalar: {
              text: scalar.text,
              number: scalar.number,
              boolean: scalar.boolean,
              null: scalar.null,
              undefinedOwn:
                Object.hasOwn(scalar, "undefined") &&
                scalar.undefined === undefined,
              bigint: scalar.bigint.toString(),
              nan: Number.isNaN(scalar.nan),
              positiveInfinity: scalar.positiveInfinity === Infinity,
              negativeInfinity: scalar.negativeInfinity === -Infinity,
              negativeZero: Object.is(scalar.negativeZero, -0),
            },
            date: { native: date instanceof Date, iso: date.toISOString() },
            map: {
              native: map instanceof Map,
              entries: Array.from(map.entries()),
            },
            set: { native: set instanceof Set, values: Array.from(set) },
            regexp: {
              native: regexp instanceof RegExp,
              source: regexp.source,
              flags: regexp.flags,
              matches: regexp.test("HELLO world"),
            },
            error: {
              native: error instanceof Error,
              name: error.name,
              message: error.message,
            },
            buffer: {
              native: buffer instanceof ArrayBuffer,
              bytes: Array.from(new Uint8Array(buffer)),
            },
            typed: {
              native: typed instanceof Uint16Array,
              values: Array.from(typed),
            },
            forwarded: yield* object.forwarded(),
            topNull,
            topUndefined: topUndefined === undefined,
            topBigint: topBigint.toString(),
            literal,
            selected,
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "streams") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const bytes = yield* object.bytes().pipe(Stream.runCollect);
          const json = yield* object.json().pipe(Stream.runCollect);
          const empty = yield* object.empty().pipe(Stream.runCollect);
          const delayed = yield* object.delayed().pipe(Stream.runCollect);
          const delivered: string[] = [];
          const failed = yield* object.failing().pipe(
            Stream.tap((value) =>
              Effect.sync(() => {
                delivered.push(value);
              }),
            ),
            Stream.runDrain,
            Effect.exit,
          );
          const cancelled = yield* object
            .cancellable()
            .pipe(Stream.take(1), Stream.runCollect);
          for (const name of [
            "bytes",
            "json",
            "empty",
            "delayed",
            "failing",
            "cancel",
          ]) {
            yield* observed(id, `stream:${name}:close`);
          }
          return {
            bytes: bytes.flatMap((chunk) => Array.from(chunk)),
            json,
            empty,
            delayed,
            delivered,
            failure: failure(failed),
            cancelled,
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "rich-streams") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const values = yield* object.richValues().pipe(
            Stream.map((value) => normalizeStreamValue(value)),
            Stream.runCollect,
          );
          yield* observed(id, "stream:rich:close");
          return {
            values,
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "stream-failures") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          let initialItems = 0;
          const initialError = yield* object.initialFailure().pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                initialItems++;
              }),
            ),
            Stream.runDrain,
            Effect.catchTag("ObjectRejected", (error) =>
              Effect.succeed({
                tag: error._tag,
                code: error.code,
                message: error.message,
              }),
            ),
          );
          const bytes: number[] = [];
          const byteError = yield* object.byteFailure().pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => {
                bytes.push(...chunk);
              }),
            ),
            Stream.runDrain,
            Effect.catchTag("ObjectRejected", (error) =>
              Effect.succeed({
                tag: error._tag,
                code: error.code,
                message: error.message,
              }),
            ),
          );
          yield* observed(id, "stream:initial-failure:close");
          yield* observed(id, "stream:byte-failure:close");
          return {
            initialItems,
            initialError,
            bytes,
            byteError,
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "stream-first-item") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const delayed = yield* object.delayedFirst().pipe(Stream.runCollect);
          yield* observed(id, "stream:delayed-first:close");
          let cancelledItems = 0;
          const fiber = yield* object.pendingFirst().pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                cancelledItems++;
              }),
            ),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* observed(id, "stream:pending-first:open");
          yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
          const interrupted = failure(yield* Fiber.await(fiber));
          yield* observed(id, "stream:pending-first:close");
          return {
            delayed,
            cancelledItems,
            interrupted,
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "nested") {
        return yield* Effect.gen(function* () {
          const parent = yield* target.open(id);
          const child = yield* Effect.gen(function* () {
            const child = yield* parent.child();
            const value: { readonly child: true } = yield* child.echo({
              child: true,
            } as const);
            const rejected = yield* child
              .reject()
              .pipe(
                Effect.catchTag("ObjectRejected", (error) =>
                  Effect.succeed({ tag: error._tag, code: error.code }),
                ),
              );
            const values = yield* child.values().pipe(Stream.runCollect);
            yield* observed(id, "stream:child:close");
            return { value, rejected, values, ping: yield* child.ping() };
          }).pipe(Effect.scoped);
          yield* observed(id, "child:close");
          return {
            child,
            ping: yield* parent.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "failures") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const rejected = yield* object.reject().pipe(
            Effect.catchTag("ObjectRejected", (error) =>
              Effect.succeed({
                tag: error._tag,
                code: error.code,
                message: error.message,
              }),
            ),
          );
          const defect = yield* object.defect().pipe(Effect.exit);
          const success = yield* object.operation("success");
          yield* observed(id, "method:success:close");
          const methodFailure = yield* object
            .operation("failure")
            .pipe(Effect.exit);
          yield* observed(id, "method:failure:close");
          const fiber = yield* object
            .operation("interrupt")
            .pipe(Effect.forkScoped);
          yield* observed(id, "method:interrupt:open");
          yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
          const interrupted = yield* Fiber.await(fiber);
          yield* observed(id, "method:interrupt:close");
          return {
            rejected,
            defect: failure(defect),
            success,
            methodFailure: failure(methodFailure),
            interrupted: failure(interrupted),
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "concurrent") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const values = yield* Effect.forEach(
            Array.from({ length: 24 }, (_, index) => index),
            (index) => object.echo({ index, label: `call-${index}` }),
            { concurrency: 8 },
          );
          return {
            values,
            ping: yield* object.ping(),
            beforeClose: yield* events(id),
          };
        }).pipe(Effect.scoped);
      }

      if (scenario === "scope-success" || scenario === "scope-failure") {
        const exit = yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          yield* object.ping();
          if (scenario === "scope-failure")
            return yield* Effect.fail(new CallerRejected());
          return "scope-ok";
        }).pipe(Effect.scoped, Effect.exit);
        return {
          exit: failure(exit),
          value: Exit.isSuccess(exit) ? exit.value : null,
        };
      }

      if (scenario === "scope-interruption") {
        const fiber = yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          yield* object.ping();
          yield* stats.append(id, "caller:acquired");
          yield* Effect.never;
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* observed(id, "caller:acquired");
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
        return { exit: failure(yield* Fiber.await(fiber)) };
      }

      if (scenario === "factory-interruption") {
        const fiber = yield* target
          .pending(id)
          .pipe(Effect.scoped, Effect.forkScoped);
        yield* observed(id, "factory:open");
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
        return { exit: failure(yield* Fiber.await(fiber)) };
      }

      if (scenario === "use-after-scope") {
        const object = yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          yield* object.ping();
          return object;
        }).pipe(Effect.scoped);
        yield* observed(id, "parent:close");
        const exit = yield* object
          .ping()
          .pipe(Effect.timeout("3 seconds"), Effect.exit);
        return { exit: failure(exit), events: yield* events(id) };
      }

      if (scenario === "performance") {
        return yield* Effect.gen(function* () {
          const object = yield* target.open(id);
          const iterations = 30;
          const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const start = yield* Effect.sync(() => performance.now());
              const value = yield* effect;
              const ms = (yield* Effect.sync(() => performance.now())) - start;
              return { value, ms };
            });
          const environment = yield* Cloudflare.WorkerEnvironment;
          const native =
            transport === "worker"
              ? environment.RpcObjectTargetWorker
              : (
                  environment.RpcObjectTarget as {
                    getByName(name: string): unknown;
                  }
                ).getByName(id);
          const direct = Cloudflare.makeRpcStub<typeof target>(native);
          yield* direct.scalar(0);
          yield* target.scalar(0);
          yield* object.scalar(0);
          const directRoot = yield* timed(
            Effect.forEach(
              Array.from({ length: iterations }, (_, index) => index),
              (index) => direct.scalar(index),
            ),
          );
          const root = yield* timed(
            Effect.forEach(
              Array.from({ length: iterations }, (_, index) => index),
              (index) => target.scalar(index),
            ),
          );
          const returned = yield* timed(
            Effect.forEach(
              Array.from({ length: iterations }, (_, index) => index),
              (index) => object.scalar(index),
            ),
          );
          const largeRecords = yield* timed(
            object.largeRecords().pipe(
              Stream.runFold(
                () => ({ count: 0, bytes: 0, sum: 0 }),
                (total, row) => ({
                  count: total.count + 1,
                  bytes: total.bytes + row.value.length,
                  sum: total.sum + row.index,
                }),
              ),
            ),
          );
          const bytes = yield* timed(object.largeBytes(256 * 1024));
          const objects = yield* timed(object.largeObjects(2000));
          const stream = yield* timed(
            object.largeStream(16, 64 * 1024).pipe(
              Stream.runFold(
                () => ({ bytes: 0, checksum: 0 }),
                (total, chunk) => ({
                  bytes: total.bytes + chunk.byteLength,
                  checksum:
                    total.checksum + chunk.reduce((sum, byte) => sum + byte, 0),
                }),
              ),
            ),
          );
          const objectBytes = yield* Effect.sync(
            () =>
              new TextEncoder().encode(JSON.stringify(objects.value))
                .byteLength,
          );
          const throughput = (bytes: number, ms: number) =>
            ms > 0 ? bytes / (ms / 1000) : null;
          return {
            iterations,
            directRootMs: directRoot.ms,
            directRootValues: directRoot.value,
            rootMs: root.ms,
            returnedMs: returned.ms,
            returnedToRootRatio: root.ms > 0 ? returned.ms / root.ms : null,
            largeRecords: { ...largeRecords.value, ms: largeRecords.ms },
            rootValues: root.value,
            returnedValues: returned.value,
            bytes: {
              size: bytes.value.byteLength,
              checksum: bytes.value.reduce((sum, byte) => sum + byte, 0),
              ms: bytes.ms,
              bytesPerSecond: throughput(bytes.value.byteLength, bytes.ms),
            },
            objects: {
              count: objects.value.length,
              first: objects.value[0],
              last: objects.value.at(-1),
              size: objectBytes,
              ms: objects.ms,
              bytesPerSecond: throughput(objectBytes, objects.ms),
            },
            stream: {
              ...stream.value,
              ms: stream.ms,
              bytesPerSecond: throughput(stream.value.bytes, stream.ms),
            },
          };
        }).pipe(Effect.scoped);
      }

      return yield* Effect.fail(new Error(`Unknown scenario: ${scenario}`));
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://rpc-object");
        if (
          request.method === "GET" &&
          (url.pathname === "/ready" || url.pathname.startsWith("/ready/"))
        ) {
          const name = url.pathname.slice("/ready/".length) || "readiness";
          const ready = yield* Effect.all([
            worker.ready(),
            objects.getByName(name).ready(),
            stats.ready(),
          ]);
          return yield* HttpServerResponse.json({ ready });
        }
        const [, transport, scenario, id] = url.pathname.split("/");
        if (request.method === "GET" && transport === "stats" && scenario) {
          return yield* HttpServerResponse.json({
            events: yield* events(scenario),
          });
        }
        if (
          request.method !== "POST" ||
          (transport !== "worker" && transport !== "do") ||
          !scenario ||
          !id
        ) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        return yield* HttpServerResponse.json(
          yield* run(transport, scenario, id),
        );
      }).pipe(
        Effect.timeout("45 seconds"),
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(RpcObjectTargetLive)),
) {}
