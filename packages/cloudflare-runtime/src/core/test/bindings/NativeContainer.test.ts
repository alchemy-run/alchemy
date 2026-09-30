import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import { isDockerAvailable } from "../helpers/docker.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const script = `
import { DurableObject } from "cloudflare:workers";
export class Sandbox extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    const path = new URL(request.url).pathname;
    if (path === "/images") return Response.json(container.images);
    if (path === "/stdin") {
      const process = await container.exec(["cat"], { stdin: "pipe" });
      const writer = process.stdin.getWriter();
      const [, output] = await Promise.all([
        writer.write(new TextEncoder().encode("input".repeat(65536))).then(() => writer.close()),
        process.output(),
      ]);
      return new Response(output.stdout);
    }
    if (path === "/snapshot") {
      const write = await container.exec(["sh", "-c", "printf persisted > /workspace-file"]);
      await write.output();
      const snapshot = await container.snapshotContainer({ name: "workspace" });
      await container.destroy();
      container.start({ containerSnapshot: snapshot, entrypoint: ["sleep", "infinity"], enableInternet: false });
      const restored = await (await container.exec(["cat", "/workspace-file"])).output();
      return new Response(restored.stdout);
    }
    await container.destroy();
    container.start({ image: path === "/builtin" ? "cloudflare/debian-trixie" : container.images[path.slice(1)], entrypoint: ["sleep", "infinity"], enableInternet: false });
    const process = await container.exec(["sh", "-c", "printf hello; printf error >&2; exit 7"]);
    const output = await process.output();
    return Response.json({ stdout: new TextDecoder().decode(output.stdout), stderr: new TextDecoder().decode(output.stderr), exitCode: output.exitCode });
  }
}
export default { fetch(request, env) { return env.SANDBOX.getByName("workspace").fetch(request); } };
`;

layer(localRuntimeLayer, { excludeTestServices: true, timeout: 120_000 })(
  "native container images",
  (it) => {
    it.effect.skipIf(!isDockerAvailable())(
      "selects named images, executes processes, and restores a filesystem snapshot",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "native-container-images",
            compatibilityDate: "2026-09-18",
            compatibilityFlags: [],
            bindings: [
              DurableObjectNamespace.local({
                binding: "SANDBOX",
                className: "Sandbox",
              }),
            ],
            modules: [{ name: "main.js", type: "ESModule", content: script }],
            durableObjectNamespaces: [
              {
                className: "Sandbox",
                sql: true,
                container: {
                  images: {
                    alpine: { imageUri: "alpine:3.21" },
                    other: { imageUri: "alpine:3.21" },
                  },
                },
              },
            ],
          });
          const images =
            yield* worker.fetchJson<Record<string, string>>("/images");
          expect(Object.keys(images).sort()).toEqual(["alpine", "other"]);
          for (const name of ["alpine", "other"]) {
            expect(yield* worker.fetchJson(`/${name}`)).toEqual({
              stdout: "hello",
              stderr: "error",
              exitCode: 7,
            });
          }
          expect(yield* worker.fetchText("/snapshot")).toBe("persisted");
          expect(yield* worker.fetchText("/stdin")).toBe("input".repeat(65536));
          const builtin = yield* startTestWorker({
            name: "native-container-no-images",
            compatibilityDate: "2026-09-18",
            compatibilityFlags: [],
            bindings: [
              DurableObjectNamespace.local({
                binding: "SANDBOX",
                className: "Sandbox",
              }),
            ],
            modules: [{ name: "main.js", type: "ESModule", content: script }],
            durableObjectNamespaces: [
              { className: "Sandbox", sql: true, container: { images: {} } },
            ],
          });
          expect(yield* builtin.fetchJson("/images")).toEqual({});
          expect(yield* builtin.fetchJson("/builtin")).toEqual({
            stdout: "hello",
            stderr: "error",
            exitCode: 7,
          });
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  },
);
