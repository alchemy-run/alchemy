import type { Storyboard } from "../storyboard";

/**
 * Pilot: launch piece 1 — "Infrastructure as Effects: your app and its
 * cloud in one program". Script adapted from
 * processes/Marketing/launch-content-plan.md; all code verbatim-shaped
 * from website/src/content/docs/what-is-alchemy.mdx.
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
        { text: '// the whole stack — this file is all of it' },
        { text: 'import * as Alchemy from "alchemy";' },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Effect from "effect/Effect";' },
        { text: 'import Worker from "./src/worker.ts";' },
        { text: "" },
        { text: 'export default Alchemy.Stack(' },
        { text: '  "my-app",' },
        {
          text: "  { providers: Cloudflare.providers(), state: Cloudflare.state() },",
        },
        { text: "  Effect.gen(function* () {" },
        { text: "    const worker = yield* Worker;", highlight: true },
        { text: "    return { url: worker.url };" },
        { text: "  }),", },
        { text: ");" },
      ],
      subtitles: [
        "One file declares the infrastructure.",
        "No YAML. No console clicking. A Stack is a TypeScript program.",
      ],
      duration: 13,
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
        { text: 'import { Bucket } from "./bucket.ts";' },
        { text: "" },
        { text: 'export default Cloudflare.Worker(' },
        { text: '  "Worker",' },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);",
          highlight: true,
        },
        { text: "" },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        { text: '        const obj = yield* bucket.get("hello.txt");' },
        { text: "        return HttpServerResponse.text(" },
        { text: '          obj ? yield* obj.text() : "Not found",' },
        { text: "        );" },
        { text: "      })," },
        { text: "    };" },
        { text: "  })," },
        { text: ");" },
      ],
      subtitles: [
        "The Worker ships its own runtime code.",
        "One line binds the bucket — the binding IS the client.",
        "No env.BUCKET. No wrangler.toml. No IAM file. Anywhere.",
      ],
      duration: 17,
    },
    {
      kind: "code",
      file: "alchemy.run.ts",
      type: false,
      lines: [
        { text: 'export default Alchemy.Stack(' },
        { text: '  "my-app",' },
        { text: "  { providers: Layer.empty },", mark: "del" },
        { text: "  { providers: Cloudflare.providers() },", mark: "add" },
        { text: "  Effect.gen(function* () {" },
        { text: "    const worker = yield* Worker;" },
        { text: "  })," },
        { text: ");" },
      ],
      callouts: [
        {
          line: 2,
          text: "Type error: Cloudflare.Worker requires Cloudflare.Providers — provided: never",
          at: 0.6,
          kind: "error",
        },
        {
          line: 3,
          text: "Wiring checks out — the compiler sees the whole cloud",
          at: 3.4,
          kind: "ok",
        },
      ],
      subtitles: [
        "Wire it wrong, and it doesn't compile.",
        "Infrastructure mistakes are type errors — caught before anything deploys.",
      ],
      duration: 11,
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
      type: false,
      lines: [
        { text: "// prefer async/await? same stack, plain handler" },
        { text: 'import type { WorkerEnv } from "../alchemy.run.ts";', mark: "add" },
        { text: "" },
        { text: "export default {", mark: "add" },
        { text: "  async fetch(req: Request, env: WorkerEnv) {", mark: "add" },
        { text: '    const obj = await env.Bucket.get("hello.txt");', mark: "add" },
        { text: '    return new Response(obj?.body ?? "Not found");', mark: "add" },
        { text: "  },", mark: "add" },
        { text: "};", mark: "add" },
      ],
      subtitles: [
        "Effect is optional.",
        "The async style gets a fully typed env via InferEnv — zero codegen.",
      ],
      duration: 11,
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
