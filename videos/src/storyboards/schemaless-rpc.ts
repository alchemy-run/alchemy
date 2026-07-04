import type { Storyboard } from "../storyboard";

/**
 * Launch piece 4 — "Typed RPC without schemas". Script adapted from
 * processes/Marketing/launch-content-plan.md §4; all code verbatim-shaped
 * from website/src/content/docs/apis/schemaless.mdx,
 * cloudflare/apis/schemaless-rpc.mdx, aws/apis/schemaless-rpc.mdx, and
 * cloudflare/compute/durable-objects.mdx.
 *
 * Code scenes are beat-driven: the file is on screen instantly, then each
 * beat cuts the subtitle and spotlights the exact lines it talks about.
 */
export const schemalessRpc: Storyboard = {
  id: "schemaless-rpc",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "Typed RPC without schemas",
      sub: "One method declaration — a typed client on every caller.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "src/greeter.ts",
      lines: [
        { text: "// a complete RPC server" },
        { text: "export default class Greeter extends Cloudflare.Worker<Greeter>()(" },
        { text: '  "Greeter",' },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        { text: "    return {" },
        {
          text: "      greet: (name: string) => Effect.succeed(`hello ${name}`),",
          appearAt: 1,
          focusAt: [2],
        },
        { text: "      fetch: Effect.gen(function* () {", focusAt: [0] },
        { text: '        return HttpServerResponse.text("ok");', focusAt: [0] },
        { text: "      }),", focusAt: [0] },
        { text: "    };" },
        { text: "  })," },
        { text: ") {}" },
      ],
      beats: [
        {
          subtitle: "A Worker returns an interface — fetch, plus methods.",
          duration: 3,
        },
        { subtitle: "Add a function returning an Effect…", duration: 3 },
        {
          subtitle: "…and it's remotely callable. This declaration IS the contract.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "code",
      file: "src/caller.ts",
      lines: [
        { text: "// another Worker — another deployed script" },
        { text: 'import Greeter from "./greeter.ts";' },
        { text: "" },
        { text: "export default class Caller extends Cloudflare.Worker<Caller>()(" },
        { text: '  "Caller",' },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const target = yield* Cloudflare.Workers.bindWorker(Greeter);",
          focusAt: [0],
        },
        { text: "" },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {", focusAt: [2] },
        {
          text: '        const greeting = yield* target.greet("world");',
          focusAt: [1, 2],
        },
        {
          text: "        return HttpServerResponse.text(greeting);",
          focusAt: [2],
        },
        { text: "      })," },
        { text: "    };" },
        { text: "  })," },
        { text: ") {}" },
      ],
      beats: [
        {
          subtitle: "Bind the class — the binding returns a typed stub.",
          duration: 3,
        },
        {
          subtitle: "greet is inferred straight from Greeter's declaration.",
          duration: 3.5,
          callout: {
            line: 11,
            text: "(method) greet(name: string): Effect<string>",
            kind: "ok",
          },
        },
        {
          subtitle: "Every property access on the stub dispatches over the wire.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "src/greeter.ts",
      lines: [
        { text: "    return {" },
        {
          text: "      greet: (name: string) => Effect.succeed(`hello ${name}`),",
          focusAt: [0],
          delAt: 1,
        },
        { text: "      greet: (name: string) =>", appearAt: 1 },
        {
          text: "        Effect.succeed({ message: `hello ${name}` }),",
          appearAt: 1,
        },
        { text: "      fetch: Effect.gen(function* () {" },
        { text: '        return HttpServerResponse.text("ok");' },
        { text: "      })," },
        { text: "    };" },
      ],
      beats: [
        {
          subtitle: "Refactor the server — change greet's return type.",
          duration: 3,
        },
        { subtitle: "The string becomes an object.", duration: 3 },
      ],
    },
    {
      kind: "code",
      file: "src/caller.ts",
      lines: [
        { text: "// the caller — unchanged, in another Worker" },
        { text: "      fetch: Effect.gen(function* () {" },
        {
          text: '        const greeting = yield* target.greet("world");',
          focusAt: [0],
        },
        {
          text: "        return HttpServerResponse.text(greeting);",
          focusAt: [1, 2],
        },
        { text: "      })," },
      ],
      beats: [
        {
          subtitle: "The caller lives across a network boundary.",
          duration: 3,
        },
        {
          subtitle: "A cross-network refactor — caught by the compiler.",
          duration: 4,
          callout: {
            line: 3,
            text: "Type '{ message: string }' is not assignable to type 'string'",
            kind: "error",
          },
        },
        {
          subtitle: "Two sides of the wire, one source of truth.",
          duration: 2.5,
        },
      ],
    },
    {
      kind: "code",
      file: "errors over the wire",
      lines: [
        {
          text: 'class KeyMissing extends Data.TaggedError("KeyMissing")<{',
          focusAt: [0],
        },
        { text: "  readonly key: string;", focusAt: [0] },
        { text: "}> {}", focusAt: [0] },
        { text: "" },
        { text: "// callee — a method that fails with a tagged error:" },
        { text: "get: (key: string) =>" },
        { text: "  kv.get(key).pipe(" },
        { text: "    Effect.flatMap((value) =>" },
        { text: "      value === null" },
        {
          text: "        ? Effect.fail(new KeyMissing({ key }))",
          focusAt: [1],
        },
        { text: "        : Effect.succeed(value)," },
        { text: "    )," },
        { text: "  )," },
        { text: "" },
        { text: "// caller — _tag and key survive the wire:" },
        { text: "const value = yield* stub.get(key).pipe(", focusAt: [2] },
        {
          text: '  Effect.catchTag("KeyMissing", (e) =>',
          focusAt: [2, 3],
        },
        { text: "    Effect.succeed(`missing: ${e.key}`),", focusAt: [2] },
        { text: "  )," },
        { text: ");" },
      ],
      beats: [
        { subtitle: "Define a tagged error…", duration: 2.5 },
        {
          subtitle: "…and fail with it on the callee — a typed failure.",
          duration: 3,
        },
        {
          subtitle: "Effect.catchTag recovers it on the caller — _tag crosses the wire.",
          duration: 3.5,
        },
        {
          subtitle: "After the catch, the compiler knows the error is handled.",
          duration: 3,
          callout: {
            line: 16,
            text: "KeyMissing — recovered; gone from the error channel",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "code",
      file: "streams",
      lines: [
        { text: "// on the Durable Object — an unbounded stream:" },
        { text: "tick: () =>", focusAt: [0] },
        { text: "  Stream.iterate(0, (i) => i + 1).pipe(", focusAt: [0] },
        {
          text: '    Stream.schedule(Schedule.spaced("100 millis")),',
          focusAt: [0],
        },
        { text: "  )," },
        { text: "" },
        { text: "// on the Worker — one stub, both call shapes:" },
        { text: "const greeting = stub.greet(name);", focusAt: [1] },
        {
          text: "const firstFive = stub.tick().pipe(Stream.take(5));",
          focusAt: [2, 3],
        },
      ],
      beats: [
        {
          subtitle: "A method can return a Stream — this one never ends.",
          duration: 3,
        },
        { subtitle: "Value methods yield* as Effects…", duration: 2.5 },
        {
          subtitle: "…streaming methods pipe as Streams. take(5), on a remote stream.",
          duration: 3,
        },
        {
          subtitle: "Backpressure crosses the wire — the server stops after five.",
          duration: 3.5,
          callout: {
            line: 8,
            text: "pulled lazily — the producer stops when the consumer stops",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "terminal",
      command: "curl https://my-app.sam.workers.dev/tick/5",
      output: ["0", "1", "2", "3", "4"],
      subtitles: [
        "Five values arrive, 100ms apart — streamed DO → Worker → HTTP.",
        "The stream ends because the consumer asked for five.",
      ],
      duration: 8,
    },
    {
      kind: "code",
      file: "what the types reject",
      lines: [
        { text: "// ❌ rejected — neither member is an Effect or a Stream:" },
        { text: "return {" },
        { text: '  version: "1.0",', focusAt: [0] },
        { text: "  greet: (name: string) => `hello ${name}`,", focusAt: [0, 1] },
        { text: "};" },
        { text: "" },
        { text: "// ✅ accepted:" },
        { text: "return {" },
        { text: '  version: () => Effect.succeed("1.0"),', focusAt: [2] },
        {
          text: "  greet: (name: string) => Effect.succeed(`hello ${name}`),",
          focusAt: [2],
        },
        { text: "};" },
      ],
      beats: [
        {
          subtitle: "A plain value — or a function returning one — fails the Shape.",
          duration: 3,
        },
        {
          subtitle: "Shapes the wire can't carry are rejected at declaration.",
          duration: 3.5,
          callout: {
            line: 3,
            text: "assignability error on the init Effect — before anything deploys",
            kind: "error",
          },
        },
        {
          subtitle: "Return an Effect and the contract holds for every caller.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "one contract, four runtimes",
      lines: [
        { text: "// { fetch, ...rpcs } — the same contract everywhere", focusAt: [4] },
        { text: "" },
        { text: "// Worker → Worker" },
        {
          text: "const target = yield* Cloudflare.Workers.bindWorker(Greeter);",
          focusAt: [0],
        },
        { text: "const greeting = yield* target.greet(name);", focusAt: [0] },
        { text: "" },
        { text: "// Worker → Durable Object" },
        {
          text: "const next = yield* counters.getByName(name).increment();",
          focusAt: [1],
        },
        { text: "" },
        { text: "// Durable Object → Container" },
        { text: "const pong = yield* container.ping();", focusAt: [2] },
        { text: "" },
        { text: "// Lambda → Firecracker MicroVM" },
        {
          text: "const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {",
          focusAt: [3],
        },
        { text: "  endpoint: vm.endpoint,", focusAt: [3] },
        { text: "  authToken,", focusAt: [3] },
        { text: "});", focusAt: [3] },
        { text: "const reply = yield* sandbox.hello(message);", focusAt: [3] },
      ],
      beats: [
        { subtitle: "Workers bind Workers over native JSRPC.", duration: 2.5 },
        {
          subtitle: "Durable Objects — a typed stub per named instance.",
          duration: 2.5,
        },
        {
          subtitle: "Containers — the same contract over the fetch transport.",
          duration: 2.5,
        },
        {
          subtitle: "Even a Firecracker microVM on AWS — connect, and the stub is typed.",
          duration: 3.5,
        },
        { subtitle: "One mechanism. Every pairing.", duration: 2.5 },
      ],
    },
    {
      kind: "end",
      title: "One contract. Every runtime.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
