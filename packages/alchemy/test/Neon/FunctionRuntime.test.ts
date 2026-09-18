import * as Alchemy from "@/index";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RuntimeFunction from "./fixtures/function-effect.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
});
const Stack = Alchemy.Stack(
  "NeonFunctionRuntime",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* RuntimeFunction;
    return { url: api.url };
  }),
);
const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll(destroy(Stack));

test(
  "Effect class preserves request isolation, streams and bodyless finalizers",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(yield* (yield* client.get(url)).text).toBe("effect");
    const stream = yield* client.get(`${url}stream?id=stream`);
    expect(yield* stream.text).toBe("data: first\n\ndata: second\n\n");
    expect((yield* client.head(`${url}?id=head`)).status).toBe(200);
    expect((yield* client.get(`${url}empty?id=empty`)).status).toBe(204);
    const parallel = yield* Effect.all(
      Array.from({ length: 4 }, (_, i) =>
        client
          .get(`${url}slow?id=parallel${i}`)
          .pipe(Effect.flatMap((response) => response.text)),
      ),
      { concurrency: 4 },
    );
    expect(parallel).toEqual(["effect", "effect", "effect", "effect"]);
    const finalized = yield* client
      .get(`${url}finalized`)
      .pipe(Effect.flatMap((response) => response.json));
    expect(finalized).toMatchObject({ active: 0 });
    expect(finalized).toMatchObject({
      finalized: expect.arrayContaining([
        "stream",
        "head",
        "empty",
        "parallel0",
        "parallel1",
        "parallel2",
        "parallel3",
      ]),
    });
  }),
  { timeout: 120_000 },
);

test(
  "waitUntil outlives the response with an independent request scope",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(
      yield* (yield* client.get(`${url}background?id=background-request`)).text,
    ).toBe("scheduled");
    const completed = yield* client.get(`${url}finalized`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        times: 8,
        until: (body) => JSON.stringify(body).includes("background-work"),
      }),
    );
    expect(completed).toMatchObject({
      finalized: expect.arrayContaining([
        "background-request",
        "background-work",
      ]),
    });
  }),
  { timeout: 120_000 },
);

test(
  "WebSocket upgrade preserves native metadata and closes the request scope",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const echoed = yield* Effect.callback<string, Error>((resume) => {
      const socket = new WebSocket(
        `${url.replace(/^http/, "ws")}websocket?id=websocket`,
      );
      socket.addEventListener("open", () => socket.send("native-upgrade"));
      socket.addEventListener(
        "message",
        (event) => {
          socket.close();
          resume(Effect.succeed(String(event.data)));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => resume(Effect.fail(new Error("Neon WebSocket handshake failed"))),
        { once: true },
      );
      return Effect.sync(() => socket.close());
    }).pipe(Effect.timeout("15 seconds"));
    expect(echoed).toBe("native-upgrade");
    const client = yield* HttpClient.HttpClient;
    const completed = yield* client.get(`${url}finalized`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        times: 8,
        until: (body) => JSON.stringify(body).includes("websocket"),
      }),
    );
    expect(completed).toMatchObject({
      finalized: expect.arrayContaining(["websocket"]),
    });
  }),
  { timeout: 120_000 },
);

test(
  "cancelling a streamed response releases its request scope",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const controller = yield* Effect.sync(() => new AbortController());
    const response = yield* Effect.tryPromise((signal) =>
      fetch(`${url}stream-cancel?id=cancelled-stream`, {
        signal: AbortSignal.any([signal, controller.signal]),
      }),
    );
    const reader = yield* Effect.sync(() => response.body!.getReader());
    const first = yield* Effect.tryPromise(() => reader.read());
    expect(first.done).toBe(false);
    yield* Effect.sync(() => controller.abort());
    yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore);
    const client = yield* HttpClient.HttpClient;
    const completed = yield* client.get(`${url}finalized`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        times: 8,
        until: (body) => JSON.stringify(body).includes("cancelled-stream"),
      }),
    );
    expect(completed).toMatchObject({
      finalized: expect.arrayContaining(["cancelled-stream"]),
    });
  }),
  { timeout: 120_000 },
);

test(
  "Effect defects produce non-success responses without leaking errors",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${url}error`);
    expect(response.status).toBe(500);
    expect(yield* response.text).not.toContain("intentional");
  }),
  { timeout: 120_000 },
);
