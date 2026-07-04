import type { Storyboard } from "../storyboard";

/**
 * Pilot: launch piece 1 — "Infrastructure as Effects: your app and its
 * cloud in one program". Script adapted from
 * processes/Marketing/launch-content-plan.md; all code verbatim-shaped
 * from website/src/content/docs/what-is-alchemy.mdx.
 *
 * Code scenes are beat-driven: the file is on screen instantly, then each
 * beat cuts the subtitle and spotlights the exact lines it talks about.
 */
export const infrastructureAsEffects: Storyboard = {
  id: "infrastructure-as-effects",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "Infrastructure as Effects",
      sub: "Your app and its cloud — one type-checked TypeScript program.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "alchemy.run.ts",
      lines: [
        { text: "// the whole stack — this file is all of it" },
        { text: 'import * as Alchemy from "alchemy";' },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Effect from "effect/Effect";' },
        { text: 'import Worker from "./src/worker.ts";', focusAt: [3] },
        { text: "" },
        { text: "export default Alchemy.Stack(", focusAt: [1] },
        { text: '  "my-app",', focusAt: [1] },
        {
          text: "  { providers: Cloudflare.providers(), state: Cloudflare.state() },",
          focusAt: [2],
        },
        { text: "  Effect.gen(function* () {" },
        { text: "    const worker = yield* Worker;", focusAt: [3] },
        { text: "    return { url: worker.url };" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        { subtitle: "One file declares the infrastructure.", duration: 3 },
        {
          subtitle: "A Stack is a TypeScript program — real code, fully type-checked.",
          duration: 3,
        },
        { subtitle: "Providers plug in as values — Cloudflare here.", duration: 3 },
        {
          subtitle: "The app itself is imported like any other module.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "code",
      file: "src/worker.ts",
      lines: [
        { text: "// the app — same program, same types" },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Effect from "effect/Effect";' },
        {
          text: 'import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";',
        },
        { text: 'import { Bucket } from "./bucket.ts";', focusAt: [1] },
        { text: "" },
        { text: "export default Cloudflare.Worker(" },
        { text: '  "Worker",' },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);",
          focusAt: [1, 3],
        },
        { text: "" },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        {
          text: '        const obj = yield* bucket.get("hello.txt");',
          focusAt: [2, 3],
        },
        { text: "        return HttpServerResponse.text(" },
        { text: '          obj ? yield* obj.text() : "Not found",' },
        { text: "        );" },
        { text: "      })," },
        { text: "    };" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "The Worker ships its own runtime code — same program, same types.",
          duration: 3,
        },
        { subtitle: "One line binds the bucket.", duration: 3.5 },
        {
          subtitle: "The binding IS the client — typed reads, straight from R2.",
          duration: 3.5,
        },
        {
          subtitle: "One line carries the config, the permissions, and the client.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "code",
      file: "alchemy.run.ts",
      lines: [
        { text: "export default Alchemy.Stack(" },
        { text: '  "my-app",' },
        { text: "  { providers: Layer.empty },", focusAt: [0], delAt: 1 },
        { text: "  { providers: Cloudflare.providers() },", appearAt: 2 },
        { text: "  Effect.gen(function* () {" },
        { text: "    const worker = yield* Worker;" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        { subtitle: "Wire it wrong…", duration: 2.5 },
        {
          subtitle: "…and it doesn't compile.",
          duration: 3.5,
          callout: {
            line: 2,
            text: "Type error: Cloudflare.Worker requires Cloudflare.Providers — provided: never",
            kind: "error",
          },
        },
        {
          subtitle: "Fix the wiring — the compiler checks the whole cloud.",
          duration: 3,
          callout: {
            line: 3,
            text: "tsc — 0 errors",
            kind: "ok",
          },
        },
        {
          subtitle:
            "Infrastructure mistakes are type errors — caught before anything deploys.",
          duration: 2.5,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy",
      header: "Apply  2 to create",
      rows: [
        { id: "Bucket", type: "Cloudflare.R2.Bucket" },
        { id: "Worker", type: "Cloudflare.Worker" },
      ],
      summary: "✓ deployed   https://my-app.sam.workers.dev",
      subtitles: [
        "One command. Alchemy plans, then makes it so.",
        "Live URL in seconds.",
      ],
      duration: 11,
    },
    {
      kind: "terminal",
      command: "curl https://my-app.sam.workers.dev",
      output: ["Hello from R2!"],
      subtitles: ["It's real — reading from the bucket it bound."],
      duration: 6,
    },
    {
      kind: "code",
      file: "src/worker.ts  (async style)",
      lines: [
        { text: "// prefer async/await? same stack, plain handler" },
        {
          text: 'import type { WorkerEnv } from "../alchemy.run.ts";',
          focusAt: [2],
        },
        { text: "" },
        { text: "export default {", focusAt: [1] },
        {
          text: "  async fetch(req: Request, env: WorkerEnv) {",
          focusAt: [1],
        },
        {
          text: '    const obj = await env.Bucket.get("hello.txt");',
          focusAt: [2],
        },
        { text: '    return new Response(obj?.body ?? "Not found");' },
        { text: "  }," },
        { text: "};" },
      ],
      beats: [
        { subtitle: "Effect is optional.", duration: 2.5 },
        {
          subtitle: "A plain async handler works on the same stack.",
          duration: 3.5,
        },
        {
          subtitle: "env is fully typed — inferred straight from the stack file.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy destroy",
      header: "Destroy  2 to delete",
      rows: [
        { id: "Worker", type: "Cloudflare.Worker", verb: "delete" },
        { id: "Bucket", type: "Cloudflare.R2.Bucket", verb: "delete" },
      ],
      summary: "✓ destroyed   2 resources removed",
      subtitles: ["Stand up infrastructure. Tear it down just as fast."],
      duration: 9,
    },
    {
      kind: "end",
      title: "Zero → production.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
