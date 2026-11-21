import * as Domain from "@alchemy.run/domain";
import { board } from "@board/cli/board";
import { sessionHeaders } from "@board/domain/Session.middleware";
import * as Command from "effect/cli/Command";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";

type Fetch = typeof globalThis.fetch;

/**
 * A sessionless MCP client for the board's `/mcp` endpoint: one JSON-RPC
 * request per call, signed in as `actor` with the board's token.
 */
export const mcpClient = (url: string, token: string, fetch: Fetch = globalThis.fetch) => {
  const request = (method: string, params: Record<string, unknown>, headers: object) =>
    Effect.tryPromise(async () => {
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
            ...params,
          },
        }),
      });
      return ((await response.json()) as { result: any }).result;
    });
  return {
    tools: request("tools/list", {}, {}),
    call: (actor: string | undefined, name: string, args: unknown) =>
      request(
        "tools/call",
        { name, arguments: args },
        actor === undefined ? {} : sessionHeaders(token, actor),
      ),
    /** Call a tool with exactly these headers, such as a browser's cookies. */
    callWith: (headers: Record<string, string>, name: string, args: unknown) =>
      request("tools/call", { name, arguments: args }, headers),
  };
};

/** The CLI's environment with no terminal: how a script or an agent runs it. */
const CliEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(120),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

/**
 * Run `board <args>` against the Api at `${url}/api` as `actor`, as the CLI
 * runs from a shell: what it prints to stdout (parsed JSON) and stderr.
 */
export const runCli = (url: string, token: string, fetch: Fetch = globalThis.fetch) =>
  Effect.fn(function* (actor: string, args: ReadonlyArray<string>) {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const console: Console.Console = {
      ...globalThis.console,
      log: (...line: ReadonlyArray<unknown>) => void stdout.push(line.join(" ")),
      error: (...line: ReadonlyArray<unknown>) => void stderr.push(line.join(" ")),
    };
    yield* Command.runWith(board, { version: "1.0.0" })(args).pipe(
      Effect.provide(Domain.protocolHttp(`${url}/api`)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(CliEnvironment),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ BOARD_TOKEN: token, BOARD_ACTOR: actor }),
        ),
      ),
      Effect.provideService(Console.Console, console),
      // As `bin.ts` runs it.
      Effect.provideService(Domain.DefaultConsistency, "strong"),
      Effect.exit,
    );
    const out = stdout.join("\n");
    return { stdout: out === "" ? undefined : JSON.parse(out), stderr: stderr.join("\n") };
  });
