import type { Storyboard } from "../storyboard";

/**
 * Launch piece 5 — "Durable Objects and Containers as Effect programs".
 * Script adapted from processes/Marketing/launch-content-plan.md §5 (with
 * the review corrections applied: the cycle is Worker↔Worker per
 * circular-bindings.mdx; the containers.mdx Sandbox exposes ping(), and
 * exec/readFile/writeFile live on the cloudflare-agent DevBox).
 *
 * All code verbatim-shaped from:
 *   website/src/content/docs/cloudflare/compute/durable-objects.mdx
 *   website/src/content/docs/cloudflare/compute/containers.mdx
 *   website/src/content/docs/infrastructure-as-effects/circular-bindings.mdx
 *   examples/cloudflare-agent/src/DevBox.ts
 */
export const durableObjectsAndContainers: Storyboard = {
  id: "durable-objects-and-containers",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "Durable Objects & Containers",
      sub: "Stateful compute as Effect programs — the class is the infrastructure and the client.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "src/counter.ts",
      lines: [
        { text: "// src/counter.ts — one stateful instance per name" },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Effect from "effect/Effect";' },
        { text: "" },
        {
          text: "export default class Counter extends Cloudflare.DurableObject<Counter>()(",
        },
        { text: '  "Counter",' },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const state = yield* Cloudflare.DurableObjectState;",
          focusAt: [1],
        },
        { text: "    return Effect.gen(function* () {" },
        {
          text: '      let count = (yield* state.storage.get<number>("count")) ?? 0;',
          focusAt: [1],
        },
        { text: "      return {" },
        { text: "        increment: () =>", focusAt: [2] },
        { text: "          Effect.gen(function* () {", focusAt: [2] },
        { text: "            count += 1;", focusAt: [2] },
        {
          text: '            yield* state.storage.put("count", count);',
          focusAt: [2],
        },
        { text: "            return count;", focusAt: [2] },
        { text: "          }),", focusAt: [2] },
        { text: "        get: () => Effect.succeed(count),", focusAt: [3] },
        { text: "      };" },
        { text: "    });" },
        { text: "  })," },
        { text: ") {}" },
      ],
      beats: [
        {
          subtitle: "A Durable Object: one stateful instance per name, worldwide.",
          duration: 3,
        },
        {
          subtitle:
            "Transactional, SQLite-backed storage — resolved as an Effect service.",
          duration: 3,
        },
        {
          subtitle: "increment is a plain function returning Effect<number>.",
          duration: 3,
        },
        {
          subtitle: "Every function you return becomes a typed RPC method.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "src/worker.ts",
      lines: [
        { text: "// src/worker.ts — bind the DO, call it by name" },
        { text: 'import Counter from "./counter.ts";' },
        { text: "" },
        { text: "export default Cloudflare.Worker(" },
        { text: '  "Worker",' },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        { text: "    const counters = yield* Counter;", focusAt: [0] },
        { text: "" },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        { text: "        const request = yield* HttpServerRequest;" },
        { text: '        if (request.method === "POST" &&' },
        { text: '            request.url.startsWith("/counter/")) {' },
        { text: '          const name = request.url.split("/").pop()!;' },
        {
          text: "          const next = yield* counters.getByName(name).increment();",
          focusAt: [1, 2],
        },
        { text: "          return HttpServerResponse.text(String(next));" },
        { text: "        }" },
        { text: '        return HttpServerResponse.text("Hello!");' },
        { text: "      })," },
        { text: "    };" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle:
            "One yield* registers the binding and hands back the namespace.",
          duration: 3.5,
        },
        {
          subtitle: "getByName returns a typed stub that mirrors the class.",
          duration: 3.5,
        },
        {
          subtitle:
            "increment(): Effect<number> — checked from Worker to instance.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy",
      header: "Apply  2 to create",
      rows: [
        { id: "Counter", type: "Cloudflare.DurableObjectNamespace" },
        { id: "Worker", type: "Cloudflare.Worker" },
      ],
      summary: "✓ deployed   https://my-app.sam.workers.dev",
      subtitles: [
        "One deploy: the Worker, the namespace, and the class migration.",
      ],
      duration: 9,
    },
    {
      kind: "terminal",
      command: "curl -X POST https://my-app.sam.workers.dev/counter/foo",
      output: [
        "1",
        "❯ curl -X POST https://my-app.sam.workers.dev/counter/foo",
        "2",
        "❯ curl -X POST https://my-app.sam.workers.dev/counter/bar",
        "1",
      ],
      subtitles: [
        "Per-key state: foo counts 1, 2…",
        "…and bar starts at 1 — its own instance, its own storage.",
      ],
      duration: 8,
    },
    {
      kind: "code",
      file: "src/counter.ts → src/worker.ts",
      lines: [
        { text: "// src/counter.ts — RPC methods can return a Stream" },
        { text: "tick: (n: number) =>", focusAt: [0] },
        { text: "  Stream.iterate(0, (i) => i + 1).pipe(", focusAt: [0] },
        { text: "    Stream.take(n),", focusAt: [0] },
        {
          text: '    Stream.schedule(Schedule.spaced("100 millis")),',
          focusAt: [0],
        },
        { text: "  ),", focusAt: [0] },
        { text: "" },
        { text: "// src/worker.ts — pipe it onto the HTTP response" },
        { text: 'if (request.url.startsWith("/tick/")) {' },
        { text: '  const n = Number(request.url.split("/").pop()!);' },
        {
          text: '  const stream = counters.getByName("tick").tick(n).pipe(',
          focusAt: [1],
        },
        { text: "    Stream.map((i) => `${i}\\n`)," },
        { text: "    Stream.encodeText," },
        { text: "  );" },
        { text: "  return HttpServerResponse.stream(stream, {", focusAt: [2] },
        { text: '    headers: { "content-type": "text/plain" },', focusAt: [2] },
        { text: "  });", focusAt: [2] },
        { text: "}" },
      ],
      beats: [
        {
          subtitle: "tick emits n values, 100ms apart — a Stream, over RPC.",
          duration: 3,
        },
        {
          subtitle: "The Worker calls it through the same typed stub…",
          duration: 3,
        },
        {
          subtitle: "…and streams every chunk straight to the client.",
          duration: 3,
        },
      ],
    },
    {
      kind: "terminal",
      command: "curl https://my-app.sam.workers.dev/tick/5",
      output: ["0", "1", "2", "3", "4"],
      subtitles: [
        "Values arrive live — DO → Worker → client, typed end-to-end.",
      ],
      duration: 6.5,
    },
    {
      kind: "code",
      file: "src/Sandbox.ts + src/Sandbox.runtime.ts",
      lines: [
        { text: "// src/Sandbox.ts — a container: same ceremony" },
        { text: "export class Sandbox extends Cloudflare.Container<", focusAt: [0] },
        { text: "  Sandbox,", focusAt: [0] },
        { text: "  { ping: () => Effect.Effect<string> }", focusAt: [0] },
        { text: '>()("Sandbox") {}', focusAt: [0] },
        { text: "" },
        { text: "// src/Sandbox.runtime.ts — a real OS process" },
        { text: "export default Sandbox.make(" },
        { text: "  { main: import.meta.url },", focusAt: [1] },
        { text: "  Effect.gen(function* () {" },
        { text: "    return Sandbox.of({" },
        { text: '      ping: () => Effect.succeed("pong"),', focusAt: [2] },
        { text: "      fetch: Effect.succeed(" },
        { text: '        HttpServerResponse.text("Hello from the container!"),' },
        { text: "      )," },
        { text: "    });" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle:
            "A Container declares its typed RPC surface — just like a DO.",
          duration: 3,
        },
        {
          subtitle:
            "main: alchemy bundles this program into the image's entrypoint.",
          duration: 3,
        },
        {
          subtitle:
            "A Durable Object starts it and calls ping() through the stub.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "examples/cloudflare-agent/src/DevBox.ts",
      lines: [
        { text: "// DevBox.ts — an agent's code sandbox, in one file" },
        { text: "export class DevBox extends Cloudflare.Container<" },
        { text: "  DevBox," },
        { text: "  {" },
        {
          text: "    readFile: (path: string) => Effect.Effect<string>;",
          focusAt: [2],
        },
        {
          text: "    writeFile: (path: string, contents: string) => Effect.Effect<void>;",
          focusAt: [2],
        },
        { text: "    exec: (command: string) => Effect.Effect<", focusAt: [2] },
        {
          text: "      { exitCode: number; stdout: string; stderr: string }",
          focusAt: [2],
        },
        { text: "    >;", focusAt: [2] },
        { text: "  }" },
        { text: '>()("DevBox") {}' },
        { text: "" },
        { text: "export default DevBox.make(" },
        { text: "  {" },
        { text: "    main: import.meta.url," },
        { text: "    dockerfile: `FROM oven/bun:1.3`,", focusAt: [1] },
        { text: "  }," },
        { text: "  Effect.gen(function* () {" },
        { text: "    const fs = yield* FileSystem.FileSystem;", focusAt: [3] },
        { text: "    const cp = yield* ChildProcessSpawner;", focusAt: [3] },
        { text: "    // readFile / writeFile / exec — built on fs + cp" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "An agent sandbox on Cloudflare — the entire container is one file.",
          duration: 3,
        },
        {
          subtitle: "The Dockerfile is one line, inline, in TypeScript.",
          duration: 3,
        },
        {
          subtitle:
            "exec, readFile, writeFile — the agent's typed RPC surface.",
          duration: 3,
        },
        {
          subtitle:
            "Implemented with Effect's FileSystem and process spawner.",
          duration: 3,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy",
      header: "Apply  2 to create",
      rows: [
        { id: "DevBox", type: "Cloudflare.ContainerApplication" },
        { id: "Agents", type: "Cloudflare.DurableObjectNamespace" },
      ],
      summary: "✓ image built → pushed to Cloudflare's registry",
      subtitles: [
        "Deploy bundles the program, builds the image, and pushes it.",
        "The DO pairing is wired automatically — one TypeScript file in, one sandbox out.",
      ],
      duration: 10,
    },
    {
      kind: "code",
      file: "src/A.ts",
      lines: [
        { text: "// src/A.ts — two Workers that call each other" },
        { text: 'import { B } from "./B.ts";', focusAt: [0] },
        { text: "" },
        { text: "export class A extends Cloudflare.Worker<", focusAt: [1] },
        { text: "  A,", focusAt: [1] },
        { text: "  { work: () => Effect.Effect<string> }", focusAt: [1] },
        { text: '>()("A") {}', focusAt: [1] },
        { text: "" },
        { text: "export default A.make(" },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const b = yield* Cloudflare.Workers.bindWorker(B);",
          focusAt: [0],
        },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        { text: "        return HttpServerResponse.text(yield* b.work());" },
        { text: "      })," },
        { text: '      work: () => Effect.succeed("A handled its half"),' },
        { text: "    };" },
        { text: "  })," },
        { text: ");" },
        { text: "" },
        { text: "// src/B.ts is the mirror image — it binds A.", focusAt: [2] },
      ],
      beats: [
        {
          subtitle: "Two Workers bind each other — a real reference cycle.",
          duration: 3,
        },
        {
          subtitle:
            "The class is a Tag — importing it across the cycle is side-effect free.",
          duration: 3,
        },
        {
          subtitle:
            "precreate reserves both URLs up front; a converge pass closes the cycle.",
          duration: 3.5,
          callout: {
            line: 21,
            text: "plan: precreate → create (deferred Outputs) → converge",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "end",
      title: "Stateful compute, one typed program per unit.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
