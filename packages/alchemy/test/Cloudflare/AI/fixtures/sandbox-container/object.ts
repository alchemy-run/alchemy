import { Sandbox } from "@/AI/Sandbox.ts";
import * as Cloudflare from "@/Cloudflare";
import { SandboxContainer } from "@/Cloudflare/AI/SandboxContainer.ts";
import * as Effect from "effect/Effect";

/**
 * The session host: a Durable Object that resolves the {@link Sandbox}
 * seam from its attached container ({@link SandboxContainer}) and
 * exposes the contract's operations as RPC. This mirrors how
 * `DriverCloudflare`'s session DO will reach its per-session machine —
 * the DO is the unit of session identity, the container is its computer.
 *
 * Every method returns a plain JSON-able result (`Effect.result`-style
 * envelopes) so the test can assert on model-visible failure strings
 * as easily as on successes.
 */
export class SandboxObject extends Cloudflare.DurableObject<SandboxObject>()(
  "SandboxObject",
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    /** Run an operation, reporting failure as a value (never a defect). */
    const attempt = <A>(operation: Effect.Effect<A, string>) =>
      operation.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );

    return Effect.gen(function* () {
      return {
        exec: (command: string, args?: ReadonlyArray<string>) =>
          attempt(sandbox.exec(command, args, { timeout: 60_000 })),
        readFile: (path: string) => attempt(sandbox.readFile(path)),
        writeFile: (path: string, content: string) =>
          attempt(sandbox.writeFile(path, content)),
        deleteFile: (path: string) => attempt(sandbox.deleteFile(path)),
        mkdir: (path: string) => attempt(sandbox.mkdir(path)),
        listFiles: (path?: string) => attempt(sandbox.listFiles(path)),
        exists: (path: string) => attempt(sandbox.exists(path)),
      };
    });
  }).pipe(Effect.provide(SandboxContainer({ enableInternet: true }))),
) {}
