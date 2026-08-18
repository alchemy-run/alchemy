/**
 * `alchemy/AWS/Serve` — the AWS cloud leaf of the `alchemy/Serve` mount
 * design (Serve/DESIGN.md, phase 4). Two surfaces:
 *
 * - {@link mount} (re-exported from `alchemy/Serve`) — the user-facing
 *   runtime handle. Mount it in whatever file the framework lets you own
 *   (a TanStack `src/server.ts`, SvelteKit's `hooks.server.ts`, a Next
 *   catch-all route file): `site.fetch(request)` answers requests your
 *   mount claims and resolves `undefined` for everything else. On AWS
 *   there is no ExecutionContext — pass nothing after the request and the
 *   request scope settles inline before the response (Lambda semantics).
 *
 * - {@link makeFrameworkFunctionHandler} — the generated framework-composite
 *   entry's helper: ONE Lambda serves the framework's HTTP (with the
 *   user's mount inside it, grafted verbatim) AND the site program's
 *   non-fetch listeners (queue consumers, schedules). It is the same
 *   entry machinery a plain effect Lambda boots
 *   (`alchemy/AWS/Lambda/EntryRuntime`), with one difference: HTTP-shaped
 *   events are answered by the FRAMEWORK's handler, never by the site
 *   program's own HTTP listener.
 *
 * ```js
 * // the generated Lambda entry of an effectful AWS Website
 * import { makeFrameworkFunctionHandler } from "alchemy/AWS/Serve";
 * import Site from "./backend.ts";
 * export const handler = await makeFrameworkFunctionHandler({
 *   site: Site,
 *   fetch: (request) => framework.fetch(request),
 * });
 * ```
 *
 * The site build is the `alchemy/Serve` bridge's memoized per-class build,
 * so the user's mount, the value-form `createClient`, and this wrapper
 * share ONE runtime in the sandbox.
 */

import { markRuntime } from "../../Serve/Bridge.ts";
import type { AnyWebsiteClass } from "../../Serve/Serve.ts";
import {
  makeFunctionEntrypoint,
  registerEntrypointExtension,
  resolveFunctionHandler,
  type LambdaEntryHandler,
} from "./EntryRuntime.ts";
import {
  functionUrlEventToWebRequest,
  isFunctionURLEvent,
} from "./HttpServer.ts";
import { lambdaServeBridge } from "./ServeBridge.ts";

export { dispose, mount } from "../../Serve/Serve.ts";
export type {
  AnyWebsiteClass,
  MountOptions,
  ServeHandle,
} from "../../Serve/Serve.ts";

/**
 * The `awslambda` global the Lambda Node.js runtime provides. Declared
 * structurally so this module type-checks outside the Lambda sandbox.
 */
interface AwsLambdaGlobal {
  streamifyResponse: (
    handler: (
      event: any,
      responseStream: NodeJS.WritableStream & { end: () => void },
      context: any,
    ) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (
      stream: unknown,
      metadata: {
        statusCode: number;
        headers: Record<string, string>;
        cookies?: Array<string>;
      },
    ) => NodeJS.WritableStream & { end: () => void };
  };
}

/** Split a `Response`'s headers into plain headers + set-cookie list. */
const splitHeaders = (
  response: Response,
): { headers: Record<string, string>; cookies: Array<string> } => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  return { headers, cookies };
};

/**
 * Write a web `Response` through `HttpResponseStream` — streamed bodies
 * ride the pipe unbuffered (SSR streaming stays intact).
 */
const writeWebResponse = async (
  aws: AwsLambdaGlobal,
  response: Response,
  responseStream: NodeJS.WritableStream & { end: () => void },
): Promise<void> => {
  const { headers, cookies } = splitHeaders(response);
  const stream = aws.HttpResponseStream.from(responseStream, {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
  });
  if (response.body === null) {
    // HttpResponseStream requires at least one write for the metadata
    // frame to flush.
    stream.write("");
    stream.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stream.write(value);
  }
  stream.end();
};

/**
 * Buffer a web `Response` into a payload-v2 result object — the fallback
 * calling convention outside the Lambda sandbox (no `awslambda` global:
 * local invocation harnesses, the floci emulator).
 */
const toBufferedFunctionUrlResult = async (
  response: Response,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  cookies?: Array<string>;
  body: string;
  isBase64Encoded: boolean;
}> => {
  const { headers, cookies } = splitHeaders(response);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const isText =
    /^text\/|application\/(json|javascript|xml|xhtml\+xml|rss\+xml)/.test(
      contentType,
    );
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !isText,
  };
};

export interface FrameworkFunctionHandlerOptions {
  /**
   * The effectful Website class — the value default-exported by the user's
   * `src/backend.ts`.
   */
  site: AnyWebsiteClass;
  /**
   * The framework's fetch-shaped node handler (`(request) => Response`),
   * with the user's mount inside it. Every HTTP-shaped event routes here
   * verbatim — the wrapper never gates or re-bridges it. Streamed response
   * bodies ride the `HttpResponseStream` pipe unbuffered.
   *
   * Exactly one of `fetch` / `streamHandler` is required.
   */
  fetch?: (request: Request) => Response | Promise<Response>;
  /**
   * A pre-streamified Lambda handler
   * (`(event, responseStream, context) => Promise<void>`) to delegate
   * HTTP-shaped events to verbatim — for frameworks whose artifact already
   * owns the `awslambda.streamifyResponse` pipeline internals (OpenNext's
   * `aws-lambda-streaming` wrapper, nitro's `aws-lambda` streaming entry).
   * The delegated handler runs inside THIS wrapper's single
   * `streamifyResponse` wrap.
   */
  streamHandler?: (
    event: any,
    responseStream: NodeJS.WritableStream & { end: () => void },
    context: any,
  ) => unknown | Promise<unknown>;
}

/**
 * Build the framework-composite Lambda handler: the plain effect-Lambda
 * entry machinery (instance-lifetime site build, listener dispatch for
 * queue/schedule/event-source events, SIGTERM shutdown window) with
 * HTTP-shaped events routed to the FRAMEWORK's handler — which contains
 * the user's `mount(Site)` — instead of the site program's own HTTP
 * listener.
 *
 * Returned as one `awslambda.streamifyResponse` wrap (the composite's
 * Function URL uses `invokeMode: RESPONSE_STREAM`): framework responses
 * stream; non-HTTP events (SQS batches, schedules) dispatch through the
 * program's registered listeners and write their JSON result to the raw
 * response stream. Outside the Lambda sandbox (no `awslambda` global) a
 * buffered `(event, context)` handler is returned instead.
 *
 * The site build is `alchemy/Serve`'s memoized per-class build — shared
 * with the user's mount and the value-form `createClient`, so the program
 * initializes exactly once per sandbox.
 */
export const makeFrameworkFunctionHandler = async (
  options: FrameworkFunctionHandlerOptions,
): Promise<unknown> => {
  if ((options.fetch === undefined) === (options.streamHandler === undefined)) {
    throw new Error(
      "makeFrameworkFunctionHandler requires exactly one of `fetch` (a " +
        "fetch-shaped framework handler) or `streamHandler` (a " +
        "pre-streamified Lambda handler).",
    );
  }
  markRuntime();
  await registerEntrypointExtension();

  // The instance-lifetime site build — the SAME memoized build the user's
  // mount (`site.fetch` via the class-carried bridge) and the value-form
  // `createClient` resolve, so the program's init runs once per sandbox.
  // Env is the Lambda sandbox env: packed binding values + the alchemy
  // stack markers `FunctionProvider` applies to every function.
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    unknown
  >;
  const runtime = await lambdaServeBridge.runtime(options.site as object, env);
  const dispatch: LambdaEntryHandler = await resolveFunctionHandler(
    runtime.context,
  );

  const aws = (globalThis as { awslambda?: AwsLambdaGlobal }).awslambda;
  if (aws === undefined) {
    // Outside the Lambda sandbox: a buffered `(event, context)` handler.
    return async (event: any, context: any): Promise<any> => {
      if (isFunctionURLEvent(event)) {
        if (options.fetch === undefined) {
          throw new Error(
            "This framework entry delegates HTTP to a pre-streamified " +
              "handler, which only runs on the AWS Lambda Node.js runtime " +
              "(the `awslambda` global is missing).",
          );
        }
        const response = await options.fetch(
          functionUrlEventToWebRequest(event),
        );
        return toBufferedFunctionUrlResult(response);
      }
      return dispatch(event, context);
    };
  }

  return aws.streamifyResponse(async (event, responseStream, context) => {
    if (isFunctionURLEvent(event)) {
      if (options.streamHandler !== undefined) {
        await options.streamHandler(event, responseStream, context);
        return;
      }
      const response = await options.fetch!(
        functionUrlEventToWebRequest(event),
      );
      await writeWebResponse(aws, response, responseStream);
      return;
    }
    // Non-HTTP events (SQS batches, schedules, event sources): dispatch
    // through the program's registered listeners. The JSON result is the
    // invocation payload (no HTTP framing); a thrown error fails the
    // invocation so event sources retry.
    const result = await dispatch(event, context);
    responseStream.write(result === undefined ? "" : JSON.stringify(result));
    responseStream.end();
  });
};

export { makeFunctionEntrypoint };
