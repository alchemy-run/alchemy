import { decodeCbor, encodeCbor } from "@alchemy.run/modal/Cbor";
import { makeRpcClient, type InvokeOps } from "@alchemy.run/modal/InvokeFunctionHttp";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

/**
 * Modal's function-call API answering as a deployed `greet` method does: it
 * decodes the call's `[args, kwargs]` and either returns `hello <name>` or
 * fails the way the entrypoint does when it refuses a keyword argument.
 */
const modal = (entrypoint: { readonly readsMeta: boolean }) => {
  const calls: Array<{ args: unknown[]; kwargs: Record<string, unknown> }> = [];
  let pending: { args: unknown[]; kwargs: Record<string, unknown> } | undefined;
  const ops = {
    map: (request: { pipelinedInputs?: Array<{ input: { args: string } }> }) =>
      Effect.sync(() => {
        const [args, kwargs] = decodeCbor(
          new Uint8Array(Buffer.from(request.pipelinedInputs![0]!.input.args, "base64")),
        ) as [unknown[], Record<string, unknown>];
        pending = { args, kwargs };
        calls.push(pending);
        return { functionCallId: `fc-${calls.length}`, pipelinedInputs: request.pipelinedInputs };
      }),
    getOutputs: () =>
      Effect.sync(() => {
        const { args, kwargs } = pending!;
        const { __alchemy_rpc_meta__: _meta, ...unknown } = kwargs;
        const refused = Object.keys(entrypoint.readsMeta ? unknown : kwargs).length > 0;
        const result = refused
          ? {
              status: "GENERIC_STATUS_FAILURE",
              exception: "TypeError('RPC method greet takes positional arguments only')",
            }
          : {
              status: "GENERIC_STATUS_SUCCESS",
              data: Buffer.from(encodeCbor(`hello ${args[0]}`)).toString("base64"),
            };
        return { outputs: [{ idx: 0, result }], lastEntryId: "1-0" };
      }),
    putInputs: () => Effect.void,
    cancel: () => Effect.void,
    blobs: {},
  } as unknown as InvokeOps;
  const client = makeRpcClient(
    { functionId: Effect.succeed("fn-1"), method: undefined },
    ops,
    Effect.succeed(["greet"]),
    Effect.succeed(undefined),
  ) as { greet: (name: string) => Effect.Effect<string, unknown> };
  return { calls, client };
};

describe(
  "Modal RPC client",
  { tags: ["unit", "provider:modal", "provider:modal:function"] },
  () => {
    it.effect("sends the caller's trace context to an entrypoint that reads it", () =>
      Effect.gen(function* () {
        const { calls, client } = modal({ readsMeta: true });
        expect(yield* client.greet("world").pipe(Effect.withSpan("caller"))).toBe("hello world");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.kwargs.__alchemy_rpc_meta__).toEqual({
          traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/),
        });
      }),
    );

    it.effect("calls an older entrypoint again without the trace context, which it refuses", () =>
      Effect.gen(function* () {
        const { calls, client } = modal({ readsMeta: false });
        expect(yield* client.greet("world").pipe(Effect.withSpan("caller"))).toBe("hello world");
        expect(calls.map((call) => call.kwargs)).toEqual([
          { __alchemy_rpc_meta__: expect.anything() },
          {},
        ]);
        expect(calls[1]!.args).toEqual(["world"]);
      }),
    );

    it.effect("sends no trace context outside a span", () =>
      Effect.gen(function* () {
        const { calls, client } = modal({ readsMeta: false });
        expect(yield* client.greet("world")).toBe("hello world");
        expect(calls.map((call) => call.kwargs)).toEqual([{}]);
      }),
    );
  },
);
