/**
 * The dev-mode session machine: this repository's OWN working tree,
 * served as a sandbox over the guest RPC protocol from a plain Bun
 * process on the host. `alchemy dev` runs it as the `Sandbox`
 * `Command.Dev` (see src/SandboxSession.ts) and points the local
 * Worker's sessions at it — no MicroVM image, no bake, no launch.
 *
 * The root is the alchemy-effect checkout (three levels up), NOT the
 * org service directory: sessions read and write the repo as a whole,
 * exactly what the baked MicroVM image holds in production.
 *
 * ```sh
 * PORT=1341 bun scripts/sandbox-dev.ts
 * ```
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

await Effect.runPromise(AI.serveSandbox({ root }));
