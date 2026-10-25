import { McpProtocol, McpServer } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Terminal from "effect/Terminal";
import * as DomainAi from "./Ai.ts";
import { type ApiServer, protocolHttp } from "./Api.ts";
import { describe, failures, type Operation } from "./ApiCatalog.ts";
import * as DomainCli from "./Cli.ts";
import * as DomainHttp from "./Http.ts";

/**
 * A parity check for an Api's surfaces: run one scenario through the Api's
 * own client, the AI toolkit, the MCP server, the HTTP API and the CLI, and
 * check that each gives the same answers. Import it from
 * `@alchemy.run/domain/Surfaces`, in tests.
 */

/** A surface {@link make} can run a call through. */
export type Surface = "client" | "toolkit" | "mcp" | "http" | "cli";

/** Every surface, in the order {@link make} runs them. */
export const all: ReadonlyArray<Surface> = ["client", "toolkit", "mcp", "http", "cli"];

/**
 * What a call gave on a surface, as JSON on the wire: the same on every
 * surface when they agree.
 *
 * - `Success`: the call's result (a receipt, a state, a page), wire-encoded.
 * - `Failure`: a typed failure, a rejection or the error of the middleware
 *   that guards the call, wire-encoded with its `_tag`.
 * - `Invalid`: the surface refused the input before the Api ran the call.
 */
export type Outcome =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly error: unknown }
  | { readonly _tag: "Invalid" };

/** The names of an entry's request/response calls: a command's tag, or `<entry>.<operation>`. */
type CallsOf<E> = E extends { readonly kind: "Command"; readonly tag: infer N extends string }
  ? N
  : E extends { readonly kind: "View"; readonly viewName: infer N extends string }
    ? `${N}.get` | `${N}.list`
    : E extends { readonly kind: "Stream"; readonly streamName: infer N extends string }
      ? `${N}.peek` | `${N}.list`
      : E extends { readonly kind: "Aggregate"; readonly aggregateName: infer N extends string }
        ? `${N}.get`
        : never;

/** What {@link make} reads from an Api class: everything each surface reads, and the Api's server. */
export interface Checkable
  extends Effect.Effect<ApiServer, never, any>, DomainAi.Toolable, DomainCli.Cliable {}

/** The request/response calls of an Api, by name. */
export type CallName<A extends Checkable> = CallsOf<A["entries"][number]>;

/** The services the surfaces need: the hosted model, and the Layers of its middleware. */
export type Requirements<A extends Checkable> = Exclude<
  Effect.Services<A["testClient"]> | Effect.Services<A["client"]> | Effect.Services<A>,
  Scope.Scope | RpcClient.Protocol
>;

/** One call of a scenario. */
export interface Call<Name extends string = string> {
  /** The call: a command's tag (`Deposit`), or `<entry>.<operation>` (`Balance.get`). */
  readonly call: Name;
  /** Its input as wire JSON, as a non-Effect caller sends it: a command's `target` and input, a read's `key` and options. */
  readonly input: unknown;
  /** The caller's headers, for the Api's middleware (a bearer token, a cookie). None by default. */
  readonly headers?: Headers.Input;
  /**
   * The part of a success to compare. Each surface runs in a world of its
   * own, so what depends on time or chance (an envelope's `at`, a
   * generated `commandId`) differs: select the rest.
   */
  readonly select?: (value: unknown) => unknown;
}

/** The options of {@link make}. */
export interface Options<A extends Checkable, E, R> {
  /** The hosted model and the Layers of its middleware. Each surface gets a fresh build of it. */
  readonly layer: Layer.Layer<Requirements<A>, E, R>;
  /** The surfaces to compare. Default: {@link all}. The first is the reference. */
  readonly surfaces?: ReadonlyArray<Surface>;
}

/**
 * The surfaces answered one call differently. `message` lists what each
 * surface gave.
 */
export class SurfacesDiffer extends Data.TaggedError("SurfacesDiffer")<{
  /** The call that differs, from 1. */
  readonly step: number;
  /** Its name (`Balance.get`). */
  readonly call: string;
  /** What each surface gave. */
  readonly outcomes: Readonly<Partial<Record<Surface, Outcome>>>;
  readonly message: string;
}> {}

// ---------------------------------------------------------------- outcomes

/** JSON with its object keys sorted, so two surfaces' answers compare by value. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  ) ?? "undefined";

const show = (outcome: Outcome): string =>
  outcome._tag === "Success"
    ? `Success ${canonical(outcome.value)}`
    : outcome._tag === "Failure"
      ? `Failure ${canonical(outcome.error)}`
      : "Invalid";

/** One call, resolved against the Api's catalog. */
interface Resolved {
  readonly op: Operation;
  readonly rpc: Rpc.AnyWithProps;
  readonly input: Record<string, unknown>;
  readonly headers: Headers.Input;
  /** Whether the call's success is not a JSON object, so a tool returns it as `{ value }`. */
  readonly wrapped: boolean;
  /** True for wire JSON that is one of the call's typed failures. */
  readonly isFailure: (json: unknown) => boolean;
  readonly encodeSuccess: (value: unknown) => Effect.Effect<unknown>;
  readonly encodeFailure: (error: unknown) => Effect.Effect<unknown>;
}

/** Run one call through a surface. */
type Runner = (call: Resolved) => Effect.Effect<Outcome>;

/** Whether values of the schema are JSON objects (as MCP requires of a tool's output). */
const isObject = (schema: Schema.Top): boolean => {
  const document = Schema.toJsonSchemaDocument(schema);
  const ref = document.schema.$ref;
  const root =
    typeof ref === "string"
      ? (document.definitions[ref.slice(ref.lastIndexOf("/") + 1)] ?? document.schema)
      : document.schema;
  return root.type === "object";
};

const unwrap = (call: Resolved, value: unknown): unknown =>
  call.wrapped ? (value as { readonly value: unknown }).value : value;

/** A typed failure in wire JSON, or a defect: a surface answered with neither. */
const failureOf = (surface: Surface, call: Resolved, json: unknown): Effect.Effect<Outcome> =>
  call.isFailure(json)
    ? Effect.succeed({ _tag: "Failure", error: json })
    : Effect.die(
        new Error(
          `${surface}: ${call.op.rpc} answered with an untyped failure: ${canonical(json)}`,
        ),
      );

/** A surface's text as JSON; text that is not JSON stays text. */
const parseJson = (text: string): unknown => {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

type Client = Record<string, unknown>;

/** Send one call through a typed client: a command takes its payload, a read its key and options. */
const invoke = (client: Client, call: Resolved, payload: unknown) => {
  const { op, headers } = call;
  if (op.kind === "Command") {
    const send = client[op.entry] as (p: unknown, o: object) => Effect.Effect<unknown, unknown>;
    return send(payload, { headers });
  }
  const { key, ...options } = payload as { readonly key: unknown };
  const reads = client[op.entry] as Record<
    string,
    (k: unknown, o: object) => Effect.Effect<unknown, unknown>
  >;
  return reads[op.operation]!(key, { ...options, headers });
};

// ---------------------------------------------------------------- the surfaces

/** The headers of the call a surface runs, for the toolkit and the CLI. */
const CurrentHeaders = Context.Reference<Headers.Input>("alchemy/Domain/Surfaces/Headers", {
  defaultValue: () => ({}),
});

type World = Context.Context<never>;

/** The Api's own in-process client, `testClient`: the reference. */
const clientSurface = (api: Checkable, _world: World) =>
  Effect.gen(function* () {
    const client = (yield* api.testClient) as Client;
    const run: Runner = (call) =>
      Schema.decodeUnknownEffect(
        Schema.toCodecJson(call.rpc.payloadSchema) as unknown as Schema.Codec<unknown, unknown>,
      )(call.input).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.succeed<Outcome>({ _tag: "Invalid" }),
          onSuccess: (payload) =>
            invoke(client, call, payload).pipe(
              Effect.matchEffect({
                onSuccess: (value) =>
                  Effect.map(call.encodeSuccess(value), (value) => ({
                    _tag: "Success" as const,
                    value,
                  })),
                onFailure: (error) =>
                  Effect.map(call.encodeFailure(error), (error) => ({
                    _tag: "Failure" as const,
                    error,
                  })),
              }),
            ),
        }),
      );
    return run;
  });

/** The Effect AI toolkit, `toToolkit`, called as a model calls it: by name, with JSON. */
const toolkitSurface = (api: Checkable, world: World) =>
  Effect.gen(function* () {
    const tools = DomainAi.toToolkit(api, { headers: Effect.service(CurrentHeaders) });
    const handlers = yield* Layer.build(
      tools.layer.pipe(Layer.provide(Layer.succeedContext(world))) as Layer.Layer<any>,
    );
    const toolkit = yield* tools.toolkit.pipe(Effect.provide(handlers));
    const run: Runner = (call) =>
      Effect.gen(function* () {
        const results = yield* toolkit.handle(DomainAi.toolName(call.op), call.input as never);
        const last = yield* Stream.runLast(results).pipe(Effect.flatMap(Effect.fromOption));
        if (!last.isFailure) {
          return { _tag: "Success", value: unwrap(call, last.encodedResult) } satisfies Outcome;
        }
        if (last.failureOrigin === "parameters") return { _tag: "Invalid" } satisfies Outcome;
        return yield* failureOf("toolkit", call, last.encodedResult);
      }).pipe(
        Effect.provideService(CurrentHeaders, call.headers),
        Effect.orDie,
      ) as Effect.Effect<Outcome>;
    return run;
  });

/** The web handler of a Layer, closed with the scope. */
const webHandler = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layer as never, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(Effect.map(({ handler }) => handler));

/** POST a JSON body to an in-process web handler. */
const post = (
  handler: (request: Request) => Promise<Response>,
  url: string,
  body: unknown,
  headers: Record<string, string>,
) =>
  Effect.promise(() =>
    handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    ),
  );

/** Headers as a plain record, for a `Request`. */
const plainHeaders = (headers: Headers.Input): Record<string, string> =>
  Object.fromEntries(
    (Symbol.iterator in headers
      ? [...(headers as Iterable<readonly [string, string]>)]
      : Object.entries(headers as Record<string, string | ReadonlyArray<string> | undefined>)
    ).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : String(value)]],
    ),
  );

/** The MCP server, `toMcp`, over its HTTP transport: a session per world, a `tools/call` per call. */
const mcpSurface = (api: Checkable, world: World) =>
  Effect.gen(function* () {
    const handler = yield* DomainAi.toMcp(api).pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: api.apiName,
          version: "0.0.0",
          path: "/mcp",
          protocols: [McpProtocol.v2025_11_25],
        }),
      ),
      Layer.provide(Layer.succeedContext(world)),
      webHandler,
    );
    let session: string | undefined;
    let id = 0;
    const rpc = (body: object, headers: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const response = yield* post(handler, "http://surface.test/mcp", body, {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          ...(session ? { "mcp-session-id": session } : {}),
          ...headers,
        });
        session ??= response.headers.get("mcp-session-id") ?? undefined;
        const text = yield* Effect.promise(() => response.text());
        return parseJson(text) as { readonly result?: any; readonly error?: unknown } | undefined;
      });
    yield* rpc({
      jsonrpc: "2.0",
      id: ++id,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "surfaces", version: "0.0.0" },
      },
    });
    yield* rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    const run: Runner = (call) =>
      Effect.gen(function* () {
        const answer = yield* rpc(
          {
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name: DomainAi.toolName(call.op), arguments: call.input },
          },
          plainHeaders(call.headers),
        );
        // The server refuses arguments the tool's schema does not accept.
        if (answer?.error !== undefined) return { _tag: "Invalid" } satisfies Outcome;
        const result = answer!.result as {
          readonly isError: boolean;
          readonly structuredContent?: unknown;
          readonly content: ReadonlyArray<{ readonly text: string }>;
        };
        if (!result.isError) {
          return {
            _tag: "Success",
            value: unwrap(call, result.structuredContent),
          } satisfies Outcome;
        }
        const error = parseJson(result.content[0]?.text ?? "");
        // Arguments the tool's schema refuses come back as a tool error with
        // the message of `effect/ai`'s `ToolParameterValidationError`.
        if (typeof error === "string" && error.startsWith("Invalid parameters for tool ")) {
          return { _tag: "Invalid" } satisfies Outcome;
        }
        return yield* failureOf("mcp", call, error);
      });
    return run;
  });

/** What an `HttpApi` needs to serve in process: no files, no server. */
const HttpPlatformInProcess = Layer.mergeAll(HttpPlatform.layer, Etag.layer, Path.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

/** The query of a read's options, as `toHttpApi` takes them. */
const queryOf = (call: Resolved): string => {
  const {
    key: _key,
    atLeast,
    ...options
  } = call.input as {
    readonly key: unknown;
    readonly atLeast?: { readonly stream: string; readonly version: number };
  } & Record<string, unknown>;
  const query = new URLSearchParams();
  if (atLeast !== undefined) {
    query.set("stream", String(atLeast.stream));
    query.set("version", String(atLeast.version));
  }
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (call.op.operation !== "list" || !["order", "take", "after"].includes(name)) {
      throw new Error(`http: ${call.op.rpc} does not publish the option ${name}`);
    }
    query.set(name, String(value));
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

/** The HTTP API, `toHttpApi`, with every request/response call published. */
const httpSurface = (api: Checkable, world: World) =>
  Effect.gen(function* () {
    const include = [
      ...new Set(
        describe(api)
          .operations.filter((op) => !op.stream)
          .map((op) => op.entry),
      ),
    ];
    const surface = DomainHttp.toHttpApi(api as never, { include: include as never });
    const handler = yield* HttpApiBuilder.layer(surface.api).pipe(
      Layer.provide(surface.layer),
      Layer.provide(Layer.succeedContext(world)),
      Layer.provide(HttpPlatformInProcess),
      webHandler,
    );
    const run: Runner = (call) =>
      Effect.gen(function* () {
        const { op } = call;
        const headers = plainHeaders(call.headers);
        const response =
          op.operation === "send"
            ? yield* post(handler, `http://surface.test/${op.entry}`, call.input, headers)
            : yield* Effect.promise(() => {
                const { key } = call.input as { readonly key?: unknown };
                // The path carries the key, so a request cannot leave it out.
                if (typeof key !== "string") {
                  throw new Error(`http: ${op.rpc} takes its key in the path, as a string`);
                }
                const path = encodeURIComponent(key) + (op.operation === "list" ? "/list" : "");
                return handler(
                  new Request(`http://surface.test/${op.entry}/${path}${queryOf(call)}`, {
                    headers,
                  }),
                );
              });
        const text = yield* Effect.promise(() => response.text());
        const json = parseJson(text);
        if (response.ok) return { _tag: "Success", value: json } satisfies Outcome;
        if (call.isFailure(json)) return { _tag: "Failure", error: json } satisfies Outcome;
        // A 400 with no typed body: the endpoint refused its input.
        if (response.status === 400) return { _tag: "Invalid" } satisfies Outcome;
        return yield* failureOf("http", call, { status: response.status, body: json });
      });
    return run;
  });

/** What the CLI runs in without a terminal: as a script or an agent runs it. */
const CliEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(120),
      rows: Effect.succeed(24),
      readInput: Effect.die("no terminal"),
      readLine: Effect.die("no terminal"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("no processes")),
  ),
);

/** The CLI, `toCli`, run with `--json` against the Api served over its HTTP protocol. */
const cliSurface = (api: Checkable, world: World) =>
  Effect.gen(function* () {
    const server = yield* api as unknown as Effect.Effect<ApiServer>;
    const serve = HttpEffect.toWebHandler(server.fetch as never);
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      serve(new Request(input, init))) as typeof globalThis.fetch;
    const cli = DomainCli.toCli(api, { name: "surface", headers: Effect.service(CurrentHeaders) });
    const run: Runner = (call) =>
      Effect.gen(function* () {
        const stdout: Array<string> = [];
        const stderr: Array<string> = [];
        const console: Console.Console = {
          ...globalThis.console,
          log: (...line: ReadonlyArray<unknown>) => void stdout.push(line.join(" ")),
          error: (...line: ReadonlyArray<unknown>) => void stderr.push(line.join(" ")),
        };
        const { op } = call;
        const args = [
          DomainCli.kebab(op.entry),
          ...(op.kind === "Command" ? [] : [op.operation]),
          "--json",
          JSON.stringify(call.input),
        ];
        const exit = yield* Command.runWith(cli, { version: "0.0.0" })(args).pipe(
          Effect.provide(protocolHttp("http://surface.test/")),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provide(CliEnvironment),
          Effect.provide(world),
          Effect.provideService(Console.Console, console),
          Effect.provideService(CurrentHeaders, call.headers),
          Effect.scoped,
          Effect.exit,
        );
        let code = -1;
        Runtime.defaultTeardown(exit as Exit.Exit<unknown, unknown>, (c) => (code = c));
        if (code === 0) {
          return { _tag: "Success", value: parseJson(stdout.join("\n")) } satisfies Outcome;
        }
        const rejected = Exit.isFailure(exit)
          ? exit.cause.reasons.some(
              (reason) => reason._tag === "Fail" && reason.error instanceof DomainCli.CallRejected,
            )
          : false;
        // The CLI refused its input (`CliError.UserError`) before it called the Api.
        if (!rejected) return { _tag: "Invalid" } satisfies Outcome;
        return yield* failureOf("cli", call, parseJson(stderr.join("\n")));
      }) as Effect.Effect<Outcome>;
    return run;
  });

const SURFACES: Record<
  Surface,
  (api: Checkable, world: World) => Effect.Effect<Runner, never, any>
> = {
  client: clientSurface,
  toolkit: toolkitSurface,
  mcp: mcpSurface,
  http: httpSurface,
  cli: cliSurface,
};

// ---------------------------------------------------------------- make

/**
 * A parity check for an Api's surfaces. The function it returns runs a
 * scenario, one call after another, through each surface: the Api's own
 * client (`testClient`), the Effect AI toolkit (`toToolkit`), the MCP server
 * (`toMcp`, over its HTTP transport), the HTTP API (`toHttpApi`, with every
 * request/response call published) and the CLI (`toCli`, against the Api's
 * HTTP protocol). Each surface gets a fresh build of `options.layer`, and
 * runs the whole scenario in it.
 *
 * Every call's {@link Outcome} is compared as wire JSON: the same success
 * value, the same typed failure (`_tag` and data, a middleware's refusal
 * too), or the same refusal of invalid input. A tool returns a value that is
 * not a JSON object as `{ value }`; the check unwraps it. If one surface
 * answers a call differently, the scenario fails with
 * {@link SurfacesDiffer}, which lists what each surface gave. If they all
 * agree, it succeeds with the outcomes of the first surface, the reference.
 *
 * Use it in tests: it runs the MCP server, the HTTP API and the CLI in
 * process, with no network.
 *
 * **Example:** One scenario, every surface
 * ```typescript
 * import * as Surfaces from "@alchemy.run/domain/Surfaces";
 *
 * const parity = Surfaces.make(CustomerApi, { layer: BankLive });
 *
 * it.live("every surface answers alike", () =>
 *   Effect.gen(function* () {
 *     const sam = { authorization: "Bearer customer:c-1" };
 *     const [deposited, refused, anonymous] = yield* parity(
 *       { call: "DepositMoney", input: { target: "a-1", amount: 100 }, headers: sam },
 *       { call: "WithdrawMoney", input: { target: "a-1", amount: 500 }, headers: sam },
 *       { call: "AccountSummary.get", input: { key: "a-1" } },
 *     );
 *     expect(refused).toEqual({
 *       _tag: "Failure",
 *       error: { _tag: "InsufficientFunds", balance: 100, requested: 500 },
 *     });
 *     expect(anonymous).toEqual({ _tag: "Failure", error: { _tag: "Unauthorized" } });
 *   }),
 * );
 * ```
 */
export const make = <A extends Checkable, E = never, R = never>(
  api: A,
  options: Options<A, E, R>,
): ((
  ...calls: ReadonlyArray<Call<CallName<A>>>
) => Effect.Effect<ReadonlyArray<Outcome>, SurfacesDiffer | E, R>) => {
  const catalog = describe(api);
  const surfaces = options.surfaces ?? all;
  if (surfaces.length === 0) throw new Error(`${api.apiName}: give make at least one surface`);
  const resolve = (call: Call): Resolved => {
    const op = catalog.operations.find((op) => op.rpc === call.call);
    if (op === undefined || op.stream) {
      throw new Error(
        op === undefined
          ? `${api.apiName} has no request/response call named ${call.call}`
          : `${api.apiName} cannot check ${call.call}: ${call.call} is a stream`,
      );
    }
    const rpc = api.group.requests.get(op.rpc) as Rpc.AnyWithProps;
    const failure = Schema.toCodecJson(
      failures([rpc.errorSchema, ...[...rpc.middlewares].map((middleware) => middleware.error)]),
    ) as unknown as Schema.Codec<unknown, unknown>;
    const success = Schema.toCodecJson(rpc.successSchema) as unknown as Schema.Codec<
      unknown,
      unknown
    >;
    const decodesAsFailure = Schema.decodeUnknownExit(failure);
    return {
      op,
      rpc,
      input: call.input as Record<string, unknown>,
      headers: call.headers ?? {},
      wrapped: !isObject(rpc.successSchema),
      isFailure: (json) =>
        json !== null && typeof json === "object" && Exit.isSuccess(decodesAsFailure(json)),
      encodeSuccess: (value) => Effect.orDie(Schema.encodeUnknownEffect(success)(value)),
      encodeFailure: (error) => Effect.orDie(Schema.encodeUnknownEffect(failure)(error)),
    };
  };
  return (...calls) => {
    // Unknown names throw here, when the scenario is built.
    const resolved = calls.map(resolve);
    const select = (call: Call, outcome: Outcome): Outcome =>
      call.select && outcome._tag === "Success"
        ? { _tag: "Success", value: call.select(outcome.value) }
        : outcome;
    const runOn = (surface: Surface) =>
      Effect.gen(function* () {
        const world = yield* Layer.build(options.layer);
        // The world serves what the surface builds now (the Api's server and clients).
        const run = yield* SURFACES[surface](api, world as World).pipe(Effect.provide(world));
        const outcomes: Array<Outcome> = [];
        for (const [index, call] of resolved.entries()) {
          const outcome = yield* run(call).pipe(
            // Name the surface and the step of a call that died.
            Effect.catchCause((cause) =>
              Effect.die(
                new Error(`${surface}: step ${index + 1} (${call.op.rpc}) died`, {
                  cause: Cause.squash(cause),
                }),
              ),
            ),
          );
          outcomes.push(select(calls[index]!, outcome));
        }
        return outcomes;
      }).pipe(Effect.scoped);
    return Effect.gen(function* () {
      const answers: Array<readonly [Surface, ReadonlyArray<Outcome>]> = [];
      for (const surface of surfaces) answers.push([surface, yield* runOn(surface)]);
      const [, reference] = answers[0]!;
      for (const [index, call] of calls.entries()) {
        const expected = canonical(reference[index]);
        if (answers.every(([, outcomes]) => canonical(outcomes[index]) === expected)) continue;
        const outcomes = Object.fromEntries(
          answers.map(([surface, outcomes]) => [surface, outcomes[index]!]),
        );
        const width = Math.max(...surfaces.map((surface) => surface.length));
        const lines = answers.map(
          ([surface, outcomes]) => `  ${surface.padEnd(width)}  ${show(outcomes[index]!)}`,
        );
        return yield* new SurfacesDiffer({
          step: index + 1,
          call: call.call,
          outcomes,
          message: [
            `Step ${index + 1} (${call.call}): the surfaces answer differently`,
            ...lines,
          ].join("\n"),
        });
      }
      return reference;
    }) as Effect.Effect<ReadonlyArray<Outcome>, SurfacesDiffer | E, R>;
  };
};
