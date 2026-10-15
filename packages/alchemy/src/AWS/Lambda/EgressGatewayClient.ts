/**
 * How a Worker (or Durable Object) asks a Lambda-hosted egress gateway to
 * mint a grant (Egress/DESIGN.md §6): a direct `lambda:InvokeFunction` with
 * a `{ "~alchemy/egress/mint": { refs, ttl } }` event, signed with the
 * cross-cloud identity `BindingHttp.ts` provisions for a Worker host. The
 * function URL carries only the sandbox's traffic; `mint` is never reachable
 * over it.
 *
 * Loaded by `Egress/Gateway.ts` with a dynamic import, only when a gateway
 * is hosted on Lambda. NOT exported from `index.ts`.
 */
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import {
  EgressGatewayError,
  fromMintReply,
  MINT_INVOKE,
  type MintInvoke,
  type MintResult,
} from "../../Egress/Gateway.ts";
import type { EgressNotServed, EgressRef } from "../../Egress/Kind.ts";
import type { Output } from "../../Output.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { hostAwsAccess, regionFromArn, withRuntimeCredentials } from "./BindingHttp.ts";

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/**
 * Build gateway `id`'s mint over `lambda:InvokeFunction`. Runs in both
 * phases (the host's IAM identity is declared in both); `grantOn` is the
 * function ARN the invoke permission is granted on, at deploy.
 */
export const makeLambdaGatewayMint = (
  id: string,
  functionArn: Effect.Effect<string>,
  grantOn: Output<string> | undefined,
) =>
  Effect.gen(function* () {
    const host = yield* Binding.Host;
    const access = yield* hostAwsAccess(host, () => ({
      label: `Allow(${host?.LogicalId}, EgressGateway(${id}).mint)`,
      policyStatements: [
        { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: grantOn ? [grantOn] : [] },
      ],
    }));
    const failed = (message: string, cause?: unknown) =>
      new EgressGatewayError({ message: `gateway ${id}: ${message}`, gateway: id, cause });

    return (
      refs: ReadonlyArray<EgressRef>,
      ttlMillis: number,
    ): Effect.Effect<MintResult, EgressNotServed | EgressGatewayError, RuntimeContext> =>
      Effect.gen(function* () {
        const FunctionName = yield* functionArn;
        if (!FunctionName) return yield* failed("its function ARN is not bound to this Worker");
        const event: MintInvoke = { [MINT_INVOKE]: { refs, ttl: ttlMillis } };
        const response = yield* withRuntimeCredentials(
          access,
          Effect.succeed(regionFromArn(FunctionName)),
          Lambda.invoke({ FunctionName, Payload: JSON.stringify(event) }),
        ).pipe(
          Effect.mapError((error: { readonly _tag: string; readonly message?: unknown }) =>
            failed(
              `invoke failed: ${error._tag}${error.message ? `: ${String(error.message)}` : ""}`,
              error,
            ),
          ),
        );
        const body = response.Payload
          ? new TextDecoder().decode(
              concat(
                Array.from(
                  yield* Stream.runCollect(
                    response.Payload as Stream.Stream<Uint8Array, unknown>,
                  ).pipe(Effect.mapError((error) => failed("reading its answer failed", error))),
                ),
              ),
            )
          : "";
        if (response.FunctionError !== undefined) {
          return yield* failed(`${response.FunctionError}: ${body}`);
        }
        return yield* fromMintReply(id, body);
      });
  });
