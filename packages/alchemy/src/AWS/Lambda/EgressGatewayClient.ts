/**
 * How a Worker (or Durable Object) asks a Lambda-hosted egress gateway to
 * mint a grant (Egress/DESIGN.md §6): a direct `lambda:InvokeFunction` with
 * a `{ "~alchemy/egress/mint": { refs, ttl } }` event, signed with the
 * host's AWS identity (`AWSBindings`: minted for a Worker host). The
 * function URL carries only the sandbox's traffic; `mint` is never reachable
 * over it.
 *
 * Loaded by `Egress/Gateway.ts` with a dynamic import, only when a gateway
 * is hosted on Lambda. NOT exported from `index.ts`.
 */
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
import * as AWSBindings from "../AWSBindings.ts";
import { regionFromArn } from "./BindingHttp.ts";

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
 * Build gateway `id`'s mint over `lambda:InvokeFunction`. At deploy it grants
 * the host invoke on `grantOn` (the gateway's function ARN), through
 * `AWSBindings`: on the host's own role, or on the IAM identity minted for a
 * host outside AWS (a Worker). The invoke signs in the function's Region.
 */
export const makeLambdaGatewayMint = (
  id: string,
  functionArn: Effect.Effect<string>,
  grantOn: Output<string> | undefined,
) =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* AWSBindings.bind`EgressGateway(${id}).mint`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: grantOn ? [grantOn] : [],
          },
        ],
      });
    }
    const invoke = yield* AWSBindings.withCredentials(
      Lambda.invoke,
      Effect.succeed(Effect.map(functionArn, regionFromArn)),
    );
    const failed = (message: string, cause?: unknown) =>
      new EgressGatewayError({ message: `gateway ${id}: ${message}`, gateway: id, cause });

    return Effect.fn(function* (
      refs: ReadonlyArray<EgressRef>,
      ttlMillis: number,
    ): Effect.fn.Return<MintResult, EgressNotServed | EgressGatewayError, RuntimeContext> {
      const FunctionName = yield* functionArn;
      if (!FunctionName) return yield* failed("its function ARN is not bound to this Worker");
      const event: MintInvoke = { [MINT_INVOKE]: { refs, ttl: ttlMillis } };
      const response = yield* invoke({ FunctionName, Payload: JSON.stringify(event) }).pipe(
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
