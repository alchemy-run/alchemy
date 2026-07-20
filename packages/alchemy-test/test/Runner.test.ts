import { expect, it } from "alchemy-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/alchemy-test.ts");
const apiUrl = pathToFileURL(resolve(here, "../src/index.ts")).href;
const effectUrl = pathToFileURL(
  resolve(here, "../../../node_modules/effect/dist/Effect.js"),
).href;

const fixture = (hook: string, body: string): string => `
  import { it, registerHook } from ${JSON.stringify(apiUrl)};
  import * as Effect from ${JSON.stringify(effectUrl)};
  registerHook(${JSON.stringify(hook)}, { body: () => Effect.gen(function* () {
    yield* Effect.log(${JSON.stringify(`${hook}-captured-output`)});
    return yield* Effect.fail(new Error(${JSON.stringify(`${hook}-sentinel`)}));
  })
  });
  ${body}
`;

it("fails the process for every hook kind and preserves hook output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-hooks-"));
  try {
    await Promise.all([
      writeFile(
        resolve(root, "before-all.test.ts"),
        fixture("beforeAll", 'it("body", () => {});'),
      ),
      writeFile(
        resolve(root, "before-each.test.ts"),
        fixture("beforeEach", 'it("body", () => {});'),
      ),
      writeFile(
        resolve(root, "after-each.test.ts"),
        fixture(
          "afterEach",
          'it.fails("expected body failure", () => { throw new Error("expected-body-failure"); });',
        ),
      ),
      writeFile(
        resolve(root, "after-all.test.ts"),
        fixture("afterAll", 'it("body", () => {});'),
      ),
    ]);

    const child = Bun.spawn(
      [process.execPath, cli, root, "--retry", "0", "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("beforeAll hook failed:");
    expect(output).toContain("beforeEach hook failed:");
    expect(output).toContain("afterEach hook failed:");
    expect(output).toContain("afterAll hook failed:");
    expect(output).toContain("Tests: 4 failed | 1 passed");
    for (const hook of ["beforeAll", "beforeEach", "afterEach", "afterAll"]) {
      expect(output).toContain(`${hook}-captured-output`);
      expect(output).toContain(`${hook}-sentinel`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
