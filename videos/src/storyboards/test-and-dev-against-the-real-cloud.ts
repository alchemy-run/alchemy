import type { Storyboard } from "../storyboard";

/**
 * Launch piece 3 — "Deploy → assert → destroy: testing and hot-reloading
 * the real cloud". Script adapted from
 * processes/Marketing/launch-content-plan.md; all code verbatim-shaped from
 * website/src/content/docs/testing/testing-a-stack.mdx,
 * cloudflare/tutorial/part-3.mdx, part-4.mdx, and
 * environments/local-development.mdx.
 */
export const testAndDevAgainstTheRealCloud: Storyboard = {
  id: "test-and-dev-against-the-real-cloud",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "Deploy → assert → destroy",
      sub: "Test and hot-reload against the real cloud.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "test/integ.test.ts",
      lines: [
        { text: "// the integration suite — it deploys the Stack it tests" },
        { text: 'import * as Cloudflare from "alchemy/Cloudflare";' },
        { text: 'import * as Test from "alchemy/Test/Bun";' },
        { text: 'import { expect } from "bun:test";' },
        { text: 'import * as Effect from "effect/Effect";' },
        { text: 'import Stack from "../alchemy.run.ts";', focusAt: [0] },
        { text: "" },
        {
          text: "const { test, beforeAll, afterAll, deploy, destroy } = Test.make({",
          focusAt: [1],
        },
        { text: "  providers: Cloudflare.providers(),", focusAt: [1] },
        { text: "  state: Cloudflare.state(),", focusAt: [1] },
        { text: "});", focusAt: [1] },
        { text: "" },
        { text: "const stack = beforeAll(deploy(Stack));", focusAt: [2] },
        {
          text: "afterAll.skipIf(!process.env.CI)(destroy(Stack));",
          focusAt: [3],
        },
      ],
      beats: [
        {
          subtitle: "The test file imports the same Stack you deploy.",
          duration: 3,
        },
        {
          subtitle: "Test.make wires your providers into the test runner.",
          duration: 3,
        },
        {
          subtitle: "beforeAll deploys the real Stack — once for the whole file.",
          duration: 3,
        },
        {
          subtitle: "afterAll destroys it on CI. Locally, the Stack stays warm.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "test/integ.test.ts",
      lines: [
        { text: "test(" },
        { text: '  "PUT and GET round-trip an object",' },
        { text: "  Effect.gen(function* () {" },
        { text: "    const { url } = yield* stack;", focusAt: [0] },
        { text: "" },
        {
          text: "    const put = yield* HttpClient.put(`${url}/hello.txt`, {",
          focusAt: [1],
        },
        { text: '      body: HttpBody.text("Hello, World!"),', focusAt: [1] },
        { text: "    });", focusAt: [1] },
        { text: "    expect(put.status).toBe(201);", focusAt: [1] },
        { text: "" },
        {
          text: "    const get = yield* HttpClient.get(`${url}/hello.txt`);",
          focusAt: [2],
        },
        {
          text: '    expect(yield* get.text).toBe("Hello, World!");',
          focusAt: [2],
        },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "Each test yields the live stack outputs — here, the Worker's URL.",
          duration: 3,
        },
        {
          subtitle: "PUT goes over live HTTP to the deployed Worker.",
          duration: 3,
        },
        {
          subtitle: "The object lands in a real R2 bucket — and reads back.",
          duration: 3,
        },
        {
          subtitle: "The suite asserts on exactly what production runs.",
          duration: 2.5,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun test test/integ.test.ts",
      header: "Apply  2 to create",
      rows: [
        { id: "Bucket", type: "Cloudflare.R2.Bucket" },
        { id: "Worker", type: "Cloudflare.Worker" },
      ],
      output: [
        "✓ PUT and GET round-trip an object",
        "✓ GET missing key returns 404",
      ],
      summary: "2 pass  0 fail",
      subtitles: [
        "One command deploys a real, isolated stack…",
        "…asserts over live HTTP — green.",
        "Deploy → assert → destroy, inside one test run.",
      ],
      duration: 13,
    },
    {
      kind: "terminal",
      command: "bun alchemy dev",
      rows: [
        { id: "Bucket", type: "Cloudflare.R2.Bucket" },
        { id: "Worker", type: "Cloudflare.Worker  (local → workerd)" },
      ],
      summary: "• http://localhost:1337   Watching for changes ...",
      subtitles: [
        "Dev mode: infrastructure deploys to the real cloud.",
        "Your Worker runs locally in workerd — production's runtime.",
      ],
      duration: 10,
    },
    {
      kind: "terminal",
      command: "curl http://localhost:1337/hello.txt",
      output: [
        "Hello, World!",
        "",
        "↻ src/worker.ts changed",
        "✓ Worker reloaded in 42ms",
      ],
      subtitles: [
        "Served from local workerd, reading the real R2 bucket.",
        "Edit the handler — reloaded in 42 milliseconds.",
      ],
      duration: 10,
    },
    {
      kind: "code",
      file: "test/integ.test.ts",
      lines: [
        { text: "// the two loops compose" },
        {
          text: "const { test, beforeAll, afterAll, deploy, destroy } = Test.make({",
        },
        { text: "  providers: Cloudflare.providers()," },
        { text: "  state: Cloudflare.state()," },
        { text: "  dev: true,", appearAt: 1, focusAt: [1, 2] },
        { text: "});" },
      ],
      beats: [
        { subtitle: "One more move: point the tests at dev mode.", duration: 2.5 },
        {
          subtitle: "One flag flips the whole suite over to local workerd.",
          duration: 3,
        },
        {
          subtitle: "Same tests — full stack traces and an attachable debugger.",
          duration: 3.5,
          callout: {
            line: 4,
            text: "beforeAll boots Workers locally — assertions hit http://localhost:1337",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "end",
      title: "Test the cloud you ship.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
