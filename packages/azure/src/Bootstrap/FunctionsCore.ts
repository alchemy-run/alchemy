/**
 * A minimal Node.js programming model for the Azure Functions worker, used by
 * both `Azure.Functions.Function` bootstraps.
 *
 * The Functions Node.js worker exposes a built-in module,
 * `@azure/functions-core`, that `@azure/functions` (the v4 programming
 * model) is written on: `registerFunction(metadata, callback)` registers a
 * function while the entry file loads (worker indexing), and
 * `setProgrammingModel` decides how invocations reach the callback. This file
 * talks to that module directly, so a deployed package needs no
 * `node_modules` and no Effect. HTTP triggers get a web-standard `Request`
 * and answer with a `Response`; other triggers get their decoded payload.
 *
 * Every function must be registered before the entry module finishes
 * loading: the worker locks indexing after that.
 *
 * @see https://github.com/Azure/azure-functions-nodejs-library/blob/v4.x/types-core/index.d.ts
 */
import { createRequire } from "node:module";
import type { TriggerBinding, TriggerInvocation } from "../Functions/internal.ts";

// Slices of the worker's RPC types (`@azure/functions-core`) this file reads.
interface RpcNullableString {
  value?: string | null;
}
interface RpcHttpData {
  method?: string | null;
  url?: string | null;
  headers?: Record<string, string> | null;
  nullableHeaders?: Record<string, RpcNullableString> | null;
  body?: RpcTypedData | null;
  rawBody?: RpcTypedData | null;
  statusCode?: string | null;
  enableContentNegotiation?: boolean | null;
}
interface RpcTypedData {
  string?: string | null;
  json?: string | null;
  bytes?: Uint8Array | null;
  stream?: Uint8Array | null;
  http?: RpcHttpData | null;
  int?: number | null;
  double?: number | null;
  collectionBytes?: { bytes?: Uint8Array[] | null } | null;
  collectionString?: { string?: string[] | null } | null;
  collectionDouble?: { double?: number[] | null } | null;
  collectionSint64?: { sint64?: number[] | null } | null;
}
interface RpcBindingInfo {
  type?: string | null;
  direction?: "in" | "out" | "inout" | null;
  [key: string]: unknown;
}
interface CoreInvocationContext {
  invocationId: string;
  request: {
    inputData?: { name?: string | null; data?: RpcTypedData | null }[] | null;
    triggerMetadata?: Record<string, RpcTypedData> | null;
  };
  metadata: { name?: string | null; bindings?: Record<string, RpcBindingInfo> | null };
}
interface InvocationModel {
  getArguments(): Promise<{ context: unknown; inputs: unknown[] }>;
  invokeFunction(context: unknown, inputs: unknown[], callback: Callback): Promise<unknown>;
  getResponse(context: unknown, result: unknown): Promise<unknown>;
}
type Callback = (...args: unknown[]) => unknown;
interface CoreApi {
  registerFunction(
    metadata: { name: string; bindings: Record<string, RpcBindingInfo> },
    callback: Callback,
  ): unknown;
  setProgrammingModel(model: {
    name: string;
    version: string;
    getInvocationModel(context: CoreInvocationContext): InvocationModel;
  }): void;
}

const TRIGGER_BINDING = "trigger";
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const decoder = new TextDecoder();

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const decodeBytes = (bytes: Uint8Array): unknown => tryJson(decoder.decode(bytes));

/** Decode a typed value the way `@azure/functions` v4 does (JSON strings parsed). */
const fromTypedData = (data: RpcTypedData | null | undefined): unknown => {
  if (data == null) return undefined;
  if (data.string != null) return tryJson(data.string);
  if (data.json != null) return JSON.parse(data.json);
  if (data.bytes != null) return decodeBytes(data.bytes);
  if (data.stream != null) return decodeBytes(data.stream);
  if (data.int != null) return data.int;
  if (data.double != null) return data.double;
  if (data.collectionString?.string != null) return data.collectionString.string.map(tryJson);
  if (data.collectionBytes?.bytes != null) return data.collectionBytes.bytes.map(decodeBytes);
  if (data.collectionDouble?.double != null) return data.collectionDouble.double;
  if (data.collectionSint64?.sint64 != null) return data.collectionSint64.sint64;
  return undefined;
};

const toRequest = (http: RpcHttpData): Request => {
  const method = (http.method ?? "GET").toUpperCase();
  const headers = new Headers();
  if (http.nullableHeaders) {
    for (const [name, value] of Object.entries(http.nullableHeaders)) {
      if (value?.value != null) headers.append(name, value.value);
    }
  } else {
    for (const [name, value] of Object.entries(http.headers ?? {})) headers.append(name, value);
  }
  const raw = http.rawBody ?? http.body;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : raw?.bytes != null
        ? new Uint8Array(raw.bytes)
        : (raw?.string ?? undefined);
  return new Request(http.url ?? "http://localhost/", { method, headers, body });
};

const toRpcHttp = async (response: unknown): Promise<RpcTypedData> => {
  const res = response instanceof Response ? response : new Response(null, { status: 500 });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    http: {
      statusCode: String(res.status),
      headers,
      enableContentNegotiation: false,
      body: { bytes: new Uint8Array(await res.arrayBuffer()) },
    },
  };
};

const isHttpTrigger = (bindings: Record<string, RpcBindingInfo>) =>
  Object.values(bindings).some((b) => b.type?.toLowerCase() === "httptrigger");

/** Programming model: one trigger input in, an HTTP response (or nothing) out. */
const programmingModel = {
  name: "@alchemy.run/azure",
  version: "1.0.0",
  getInvocationModel(core: CoreInvocationContext): InvocationModel {
    const bindings = core.metadata.bindings ?? {};
    const http = isHttpTrigger(bindings);
    return {
      getArguments: async () => {
        const trigger = (core.request.inputData ?? []).find(
          (input) => input.name != null && bindings[input.name]?.direction === "in",
        );
        const metadata: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(core.request.triggerMetadata ?? {})) {
          metadata[key] = fromTypedData(value);
        }
        const context = {
          invocationId: core.invocationId,
          functionName: core.metadata.name ?? "",
          metadata,
        };
        const input =
          http && trigger?.data?.http != null
            ? toRequest(trigger.data.http)
            : fromTypedData(trigger?.data);
        return { context, inputs: [input] };
      },
      invokeFunction: async (context, inputs, callback) => await callback(inputs[0], context),
      getResponse: async (_context, result) =>
        http
          ? { invocationId: core.invocationId, outputData: [], returnValue: await toRpcHttp(result) }
          : { invocationId: core.invocationId, outputData: [] },
    };
  },
};

let core: CoreApi | undefined;

/**
 * The worker's built-in module. It is served by the worker's `require` hook,
 * so it is loaded with `createRequire` (never a static import, which a
 * bundler would try to resolve).
 */
const coreApi = (): CoreApi => {
  if (core === undefined) {
    const specifier = ["@azure", "functions-core"].join("/");
    core = createRequire(import.meta.url)(specifier) as CoreApi;
    core.setProgrammingModel(programmingModel);
  }
  return core;
};

/**
 * Register the catch-all HTTP function: every route and method (the host's
 * route prefix is empty), anonymous access.
 */
export const registerHttpFunction = (
  name: string,
  handler: (request: Request) => Promise<Response>,
) =>
  coreApi().registerFunction(
    {
      name,
      bindings: {
        req: {
          type: "httpTrigger",
          direction: "in",
          authLevel: "anonymous",
          methods: HTTP_METHODS,
          route: "{*path}",
          properties: { supportsDeferredBinding: "false" },
        },
        $return: { type: "http", direction: "out" },
      },
    },
    (request) => handler(request as Request),
  );

/** Register a non-HTTP trigger function; a rejected `run` fails the invocation. */
export const registerTriggerFunction = (
  name: string,
  binding: TriggerBinding,
  run: (invocation: TriggerInvocation) => Promise<void>,
) =>
  coreApi().registerFunction(
    {
      name,
      bindings: {
        [TRIGGER_BINDING]: {
          ...binding,
          direction: "in",
          properties: { supportsDeferredBinding: "false" },
        },
      },
    },
    (input, context) => {
      const ctx = context as Omit<TriggerInvocation, "input">;
      return run({ ...ctx, input });
    },
  );
