/**
 * nanocode on Cloudflare: its WebAssembly module in the Worker, its journal
 * in a Durable Object's SQLite.
 *
 * @module
 */
import { durableObjectRuns } from "@alchemy.run/ai/Cloudflare/Runs";
import { memoryRunStore } from "@alchemy.run/ai/Runs";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Contracts } from "nanocode-ts";
import { NanocodeError } from "../Errors.ts";
import { Host } from "../Host.ts";

interface SqlStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: ReadonlyArray<Contracts.SqlValue>
    ): { raw(): IterableIterator<Array<Contracts.SqlValue>> };
  };
  transactionSync<A>(closure: () => A): A;
}

const outside = "NanocodeCloudflare.DurableObjectHost is only available inside a Durable Object";

/**
 * nanocode in a Durable Object. Every model call and tool call of a
 * session is journaled in the object's own SQLite, so a session continues
 * after the instance is evicted or redeployed, and a submitted prompt
 * (`session.submit`) that an instance did not live to finish is continued
 * from the object's alarm. The WebAssembly module
 * (about 8 MB compressed) is uploaded with the Worker.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * const HarnessLive = Layer.mergeAll(FastLive, NanocodeCloudflare.DurableObjectHost);
 * ```
 *
 * @layer
 * @provides Nanocode.Host
 * @peer nanocode-ts
 */
export const DurableObjectHost: Layer.Layer<Host> = Layer.succeed(Host, {
  instance: Effect.map(Effect.serviceOption(DurableObjectState), (state) => ({
    // At plan time the state is a stand-in with no id, and nothing opens a session.
    id: Option.match(state, { onNone: () => "", onSome: (state) => state.id?.toString() ?? "" }),
    module: Effect.tryPromise({
      // Imported only in the Worker, where the bundler has compiled it.
      try: () =>
        // @ts-ignore -- a `.wasm` import has no types; the Worker's bundler makes it a compiled module
        (import("nanocode-ts/nanocode_wasm.wasm") as Promise<{ default: WebAssembly.Module }>).then(
          (wasm) => wasm.default,
        ),
      catch: (cause) =>
        new NanocodeError({ message: "nanocode's WebAssembly module could not be loaded", cause }),
    }),
    ...(Option.isSome(state)
      ? {
          runs: durableObjectRuns(state.value, "nanocode").store,
          callbacks: durableObjectRuns(state.value, "nanocode").callbacks,
        }
      : { runs: memoryRunStore() }),
    sql: Option.isNone(state)
      ? Effect.fail(new NanocodeError({ message: outside }))
      : Effect.sync((): Contracts.SqlHost => {
          const storage = (state.value.raw as unknown as { storage: SqlStorage }).storage;
          return {
            transaction: (_kind, _operation, statements, access = "write") => {
              const run = () =>
                statements.map(([query, ...values]) => [
                  ...storage.sql.exec(query, ...values).raw(),
                ]);
              return access === "read" ? run() : storage.transactionSync(run);
            },
          };
        }),
  })),
});
