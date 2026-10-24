import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Environment variable the deploy side writes when the Function URL uses
 * `invokeMode: "RESPONSE_STREAM"`. The runtime then exports its handler
 * through `awslambda.streamifyResponse` and pipes `HttpServerResponse`
 * bodies into the response stream instead of buffering them.
 */
export const RESPONSE_STREAM_ENV = "ALCHEMY_LAMBDA_RESPONSE_STREAM";

/** The writable `awslambda.streamifyResponse` hands the handler. */
export interface LambdaWritable {
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  once(event: "drain" | "error" | "close", listener: (...args: any[]) => void): unknown;
  removeListener(event: "drain" | "error" | "close", listener: (...args: any[]) => void): unknown;
}

/** The `awslambda` global the Lambda Node.js runtime installs. */
export interface AwsLambdaGlobal {
  streamifyResponse: (
    handler: (event: any, responseStream: LambdaWritable, context: any) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (
      stream: LambdaWritable,
      metadata: {
        statusCode: number;
        headers: Record<string, string>;
        cookies?: string[];
      },
    ) => LambdaWritable;
  };
}

export const awslambdaGlobal = (): AwsLambdaGlobal | undefined =>
  (globalThis as { awslambda?: AwsLambdaGlobal }).awslambda;

/**
 * The response stream of the current invocation of a streaming Function.
 * Provided per invocation by the Lambda dispatcher; the HTTP handler writes
 * the response into it and marks it `used` so the dispatcher doesn't also
 * write the handler's return value.
 */
export class LambdaResponseStream extends Context.Service<
  LambdaResponseStream,
  {
    readonly awslambda: AwsLambdaGlobal;
    readonly stream: LambdaWritable;
    used: boolean;
  }
>()("AWS.Lambda.ResponseStream") {}

export class ResponseStreamError extends Data.TaggedError("AWS.Lambda.ResponseStreamError")<{
  readonly cause: unknown;
}> {}

const write = (stream: LambdaWritable, chunk: string | Uint8Array) =>
  Effect.callback<void, ResponseStreamError>((resume) => {
    if (stream.write(chunk)) {
      resume(Effect.void);
      return;
    }
    // Back-pressure: wait for the client side to drain before reading the
    // next chunk from the response body.
    const cleanup = () => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(new ResponseStreamError({ cause })));
    };
    const onClose = () => {
      cleanup();
      resume(Effect.fail(new ResponseStreamError({ cause: "response stream closed" })));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    return Effect.sync(cleanup);
  });

/**
 * Write an `HttpServerResponse` into a Lambda response stream: status,
 * headers, and cookies go in the `HttpResponseStream` prelude, then each
 * body chunk is written as soon as the body produces it.
 */
export const pipeResponseToStream = Effect.fn(function* (
  response: HttpServerResponse.HttpServerResponse,
  sink: LambdaResponseStream["Service"],
) {
  sink.used = true;
  const context = yield* Effect.context();
  const webResponse = HttpServerResponse.toWeb(response, { context });
  const headers = new Headers(webResponse.headers);
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  headers.delete("set-cookie");

  const stream = sink.awslambda.HttpResponseStream.from(sink.stream, {
    statusCode: webResponse.status,
    headers: Object.fromEntries(headers.entries()),
    ...(cookies.length > 0 ? { cookies } : {}),
  });

  const reader = webResponse.body?.getReader();
  const pipeBody = Effect.gen(function* () {
    if (reader === undefined) {
      // The prelude only flushes on the first write.
      return yield* write(stream, "");
    }
    while (true) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) => new ResponseStreamError({ cause }),
      });
      if (next.done) return;
      yield* write(stream, next.value);
    }
  });
  // The status line is already on the wire, so a body that fails mid-way
  // can only be cut short: log it and end the stream.
  yield* pipeBody.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Lambda response stream ended early", error.cause).pipe(
        Effect.andThen(Effect.sync(() => reader?.cancel(error.cause).catch(() => {}))),
      ),
    ),
    Effect.ensuring(Effect.sync(() => stream.end())),
  );
});
