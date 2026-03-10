import { Function as LambdaFunction } from "@/AWS/Lambda/Function";
import { HttpServer as LambdaHttpServer } from "@/AWS/Lambda/HttpServer";
import type { ListenHandler, ServerlessExecutionContext } from "@/Host";
import * as Http from "@/Http";
import type {
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { TestHttpEffect } from "./HttpServer.fixture";

describe("AWS.Lambda.HttpServer", () => {
  it("maps a Function URL event into HttpServerRequest", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/inspect",
          rawQueryString: "jobId=job-123&trace=1",
          headers: {
            "x-forwarded-proto": "https",
            "x-request-id": "req-123",
          },
          cookies: ["session=abc", "theme=dark"],
          requestContext: {
            http: {
              method: "GET",
              path: "/inspect",
              sourceIp: "203.0.113.42",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body ?? "")).toEqual({
      method: "GET",
      url: "/inspect?jobId=job-123&trace=1",
      originalUrl:
        "https://example.lambda-url.us-east-1.on.aws/inspect?jobId=job-123&trace=1",
      host: "example.lambda-url.us-east-1.on.aws",
      protocol: "https",
      requestId: "req-123",
      remoteAddress: "203.0.113.42",
      query: {
        jobId: "job-123",
        trace: "1",
      },
      cookies: {
        session: "abc",
        theme: "dark",
      },
    });
  });

  it("maps HttpServerResponse into a Function URL result", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/jobs",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            content: "ship it",
          }),
          requestContext: {
            http: {
              method: "POST",
              path: "/jobs",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(result.headers).toMatchObject({
      "content-type": "application/json",
      "x-handler": "lambda-http",
    });
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies?.[0]).toContain("job-session=created");
    expect(JSON.parse(result.body ?? "")).toEqual({
      method: "POST",
      url: "/jobs",
      payload: {
        content: "ship it",
      },
    });
    expect(result.body).not.toContain("HttpServerResponse");
  });

  it("base64 encodes binary responses", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/binary",
          requestContext: {
            http: {
              method: "GET",
              path: "/binary",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-type"]).toBe("application/octet-stream");
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body ?? "", "base64").toString("utf8")).toBe(
      "alchemy",
    );
  });
});

const invoke = async (
  event: LambdaFunctionURLEvent,
): Promise<LambdaFunctionURLResult> => {
  const { listeners, runtime } = makeRuntime();

  await Effect.runPromise(
    Http.serve(TestHttpEffect).pipe(
      Effect.provide(
        LambdaHttpServer.pipe(
          Layer.provide(Layer.succeed(LambdaFunction.Runtime, runtime)),
        ),
      ),
    ),
  );

  const handlers = await Effect.runPromise(
    Effect.all(listeners, { concurrency: "unbounded" }),
  );

  for (const handler of handlers) {
    const response = handler(event);
    if (Effect.isEffect(response)) {
      return await Effect.runPromise(response);
    }
  }

  throw new Error("No Lambda handler was registered");
};

const makeRuntime = (): {
  listeners: Array<Effect.Effect<ListenHandler>>;
  runtime: ServerlessExecutionContext;
} => {
  const listeners: Array<Effect.Effect<ListenHandler>> = [];

  return {
    listeners,
    runtime: {
      type: "AWS.Lambda.Function",
      id: "TestFunction",
      env: {},
      exports: {},
      get: <T>() => Effect.succeed(undefined as T),
      set: () => Effect.succeed("TEST_VALUE"),
      listen: ((handler: ListenHandler | Effect.Effect<ListenHandler>) =>
        Effect.sync(() => {
          listeners.push(
            Effect.isEffect(handler) ? handler : Effect.succeed(handler),
          );
        })) as ServerlessExecutionContext["listen"],
    },
  };
};

const makeEvent = (
  overrides: Partial<LambdaFunctionURLEvent> = {},
): LambdaFunctionURLEvent => {
  const event: LambdaFunctionURLEvent = {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    cookies: undefined,
    headers: {
      host: "example.lambda-url.us-east-1.on.aws",
      "x-forwarded-proto": "https",
    },
    queryStringParameters: undefined,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.us-east-1.on.aws",
      domainPrefix: "example",
      http: {
        method: "GET",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.10",
        userAgent: "vitest",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "09/Mar/2026:00:00:00 +0000",
      timeEpoch: 1741478400000,
    },
    body: undefined,
    pathParameters: undefined,
    isBase64Encoded: false,
    stageVariables: undefined,
  };

  return {
    ...event,
    ...overrides,
    headers: {
      ...event.headers,
      ...overrides.headers,
    },
    requestContext: {
      ...event.requestContext,
      ...overrides.requestContext,
      http: {
        ...event.requestContext.http,
        ...overrides.requestContext?.http,
      },
    },
  };
};

const asStructuredResult = (
  result: LambdaFunctionURLResult,
): Exclude<LambdaFunctionURLResult, string> => {
  if (typeof result === "string") {
    throw new Error(`Expected a structured Lambda response, got: ${result}`);
  }

  return result;
};
