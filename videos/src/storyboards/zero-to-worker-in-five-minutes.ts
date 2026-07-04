import type { Storyboard } from "../storyboard";

/**
 * Launch piece 2 — "Zero → production: a typed Cloudflare Worker in five
 * minutes". Script adapted from processes/Marketing/launch-content-plan.md
 * (§2, with the review corrections applied: the typed-error beat uses
 * R2Error and the missing-key → null → 404 runtime path; the five-minute
 * subtitle lands at part-1's documented milestone, the deployed bucket).
 *
 * All code verbatim-shaped from website/src/content/docs/cloudflare/tutorial/
 * part-1.mdx + part-2.mdx and what-is-alchemy.mdx (§Two styles).
 */
export const zeroToWorkerInFiveMinutes: Storyboard = {
  id: "zero-to-worker-in-five-minutes",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "Zero → production",
      sub: "An empty directory to a typed Cloudflare Worker — deployed and serving.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "alchemy.run.ts",
      lines: [
        { text: "// an empty directory. first file: the Stack" },
        { text: 'import * as Alchemy from "alchemy";' },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Effect from "effect/Effect";' },
        { text: 'import * as Layer from "effect/Layer";', delAt: 3 },
        { text: "" },
        { text: "export default Alchemy.Stack(", focusAt: [0] },
        { text: '  "MyApp",', focusAt: [0] },
        { text: "  {" },
        { text: "    providers: Layer.empty,", focusAt: [2], delAt: 3 },
        { text: "    providers: Cloudflare.providers(),", appearAt: 3 },
        { text: "    state: Cloudflare.state()," },
        { text: "  }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: '    const bucket = yield* Cloudflare.R2.Bucket("Bucket");',
          focusAt: [1],
        },
        { text: "    return { bucketName: bucket.bucketName };" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "One file declares the stack — real TypeScript.",
          duration: 3,
        },
        { subtitle: "Ask for an R2 bucket.", duration: 3 },
        {
          subtitle:
            "The tutorial wires the providers wrong on purpose — the compiler catches it.",
          duration: 3.5,
          callout: {
            line: 9,
            text: "Type error: Layer.empty doesn't provide Cloudflare.Providers",
            kind: "error",
          },
        },
        {
          subtitle: "Swap in Cloudflare.providers() — green.",
          duration: 3,
          callout: {
            line: 10,
            text: "tsc — 0 errors",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy",
      header: "Plan  1 to create",
      rows: [{ id: "Bucket", type: "Cloudflare.R2.Bucket" }],
      summary: '✓ deployed   bucketName: "myapp-bucket-a1b2c3d4e5"',
      subtitles: [
        "Plan, confirm, create.",
        "A live bucket — under five minutes in, as part 1 promises.",
      ],
      duration: 9,
    },
    {
      kind: "code",
      file: "src/worker.ts",
      lines: [
        { text: "// the app — a Worker in the same program" },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Effect from "effect/Effect";' },
        { text: 'import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";' },
        { text: 'import { Bucket } from "./bucket.ts";' },
        { text: "" },
        { text: "export default Cloudflare.Worker(", focusAt: [0] },
        { text: '  "Worker",' },
        { text: "  { main: import.meta.url },", focusAt: [0] },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);",
          focusAt: [1],
        },
        { text: "" },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        {
          text: '        const obj = yield* bucket.get("hello.txt");',
          focusAt: [2],
        },
        { text: "        return obj" },
        { text: "          ? HttpServerResponse.text(yield* obj.text())" },
        {
          text: '          : HttpServerResponse.text("Not found", { status: 404 });',
          focusAt: [2],
        },
        { text: "      })," },
        { text: "    };" },
        {
          text: "  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),",
          focusAt: [3],
        },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "A Worker carries its runtime code inside the resource.",
          duration: 3,
        },
        {
          subtitle:
            "One line binds the bucket — config, permission, and the typed client.",
          duration: 3.5,
        },
        {
          subtitle: "A missing key comes back null — handle it with a 404.",
          duration: 3,
        },
        {
          subtitle: "The binding layer is provided on the Worker itself.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "src/worker.ts",
      lines: [
        { text: "// add a PUT route that writes to the bucket" },
        { text: "fetch: Effect.gen(function* () {" },
        { text: "  const request = yield* HttpServerRequest;" },
        { text: '  const key = request.url.split("/").pop()!;' },
        { text: "" },
        { text: '  if (request.method === "PUT") {', focusAt: [0] },
        { text: "    yield* bucket.put(key, request.stream, {", focusAt: [0, 1] },
        { text: '      contentLength: Number(request.headers["content-length"] ?? 0),' },
        { text: "    });" },
        { text: "    return HttpServerResponse.empty({ status: 201 });" },
        { text: "  }" },
        { text: "" },
        { text: "  // …the GET route from before" },
        { text: "}),", delAt: 2 },
        { text: "}).pipe(", appearAt: 2 },
        {
          text: '  Effect.catchTag("R2Error", (error) =>',
          appearAt: 2,
          focusAt: [2, 3],
        },
        { text: "    Effect.succeed(", appearAt: 2 },
        {
          text: "      HttpServerResponse.text(error.message, { status: 500 }),",
          appearAt: 2,
          focusAt: [2],
        },
        { text: "    ),", appearAt: 2 },
        { text: "  ),", appearAt: 2 },
        { text: "),", appearAt: 2 },
      ],
      beats: [
        { subtitle: "Add a PUT route that writes to the bucket…", duration: 3 },
        {
          subtitle:
            "…and it doesn't compile: bucket.put can fail with a typed R2Error.",
          duration: 3.5,
          callout: {
            line: 6,
            text: "Type error: 'R2Error' is not assignable to 'HttpServerError | HttpBodyError'",
            kind: "error",
          },
        },
        {
          subtitle: "catchTag turns the failure into a 500…",
          duration: 3,
        },
        {
          subtitle:
            "…and the error channel is clean again — runtime failures, checked at compile time.",
          duration: 3.5,
          callout: {
            line: 15,
            text: "tsc — 0 errors",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy",
      header: "Plan  1 to create",
      rows: [{ id: "Worker", type: "Cloudflare.Worker" }],
      summary: "✓ deployed   https://myapp-worker-dev-you-abc123.workers.dev",
      subtitles: [
        "The Worker rides the same deploy loop.",
        "A live URL on Cloudflare's edge.",
      ],
      duration: 9,
    },
    {
      kind: "terminal",
      command: "curl https://myapp-worker-dev-you-abc123.workers.dev/hello.txt",
      output: ["Hello, world!"],
      subtitles: ["PUT an object, read it back — typed end to end."],
      duration: 6,
    },
    {
      kind: "code",
      file: "alchemy.run.ts + src/worker.ts  (async style)",
      lines: [
        { text: "// prefer async/await? same stack, plain handler" },
        {
          text: "export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;",
          focusAt: [1],
        },
        { text: "" },
        { text: 'export const Worker = Cloudflare.Worker("Worker", {' },
        { text: '  main: "./src/worker.ts",' },
        { text: "  env: { Bucket },", focusAt: [0, 1] },
        { text: "});" },
        { text: "" },
        { text: "// src/worker.ts" },
        { text: 'import type { WorkerEnv } from "../alchemy.run.ts";' },
        { text: "" },
        { text: "export default {" },
        {
          text: "  async fetch(request: Request, env: WorkerEnv) {",
          focusAt: [2],
        },
        {
          text: '    const object = await env.Bucket.get("key");',
          focusAt: [2],
        },
        { text: "    return new Response(object?.body ?? null);" },
        { text: "  }," },
        { text: "};" },
      ],
      beats: [
        {
          subtitle: "Prefer async/await? Pass the bucket as env.",
          duration: 2.5,
        },
        {
          subtitle:
            "InferEnv derives the env type straight from the stack declaration.",
          duration: 3.5,
        },
        {
          subtitle:
            "env.Bucket is fully typed — same declarations, same CLI, same deploy.",
          duration: 3.5,
        },
      ],
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
