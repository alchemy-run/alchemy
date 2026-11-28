import { AccountId } from "@bank/domain/Account/Account.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { BankUI, Deliver } from "../src/Bank.ts";
import { Client } from "./Domain.ts";

const accountId = AccountId.make("c-1-main");

/** Deliver's work, over the adapter's Commands and the CustomerApi client in context. */
const deliver = (
  intents: ReadonlyArray<{ commandId: string; kind: "deposit" | "withdrawal"; amount: number }>,
) =>
  Deliver.make({ accountId, intents }).effect.pipe(
    Effect.provide(Deliver.layer.pipe(Layer.provide(BankUI.layer))),
  );
it.live("retries only the unknown intent with its original id and queues the rest", () =>
  Effect.gen(function* () {
    const client = yield* CustomerApi.Client;
    const ids: Array<string | undefined> = [];
    const result = yield* deliver([
      { commandId: "page:0", kind: "deposit", amount: 100 },
      { commandId: "page:1", kind: "deposit", amount: 200 },
    ]).pipe(
      Effect.provideService(CustomerApi.Client, {
        ...client,
        // The server applies each send; every reply is lost on the way back.
        DepositMoney: (input, options) =>
          Effect.suspend(() => {
            ids.push(options?.commandId);
            return client.DepositMoney(input, options);
          }).pipe(
            Effect.exit,
            Effect.andThen(
              Effect.fail(
                RpcClientError.RpcClientError.make({
                  reason: RpcClientError.RpcClientDefect.make({
                    cause: "lost reply",
                    message: "lost reply",
                  }),
                }),
              ),
            ),
          ),
      }),
    );
    expect(ids).toEqual(["page:0", "page:0", "page:0", "page:0"]);
    expect(result).toMatchObject({ _tag: "CompletedDeliver" });
    expect((result as { outcomes: unknown }).outcomes).toEqual([
      { commandId: "page:0", result: "Queued", reason: Option.none() },
      { commandId: "page:1", result: "Queued", reason: Option.none() },
    ]);
  }).pipe(Effect.provide(Client)),
);

it.live("does not retry middleware denial and sends later intents", () =>
  Effect.gen(function* () {
    const result = yield* deliver([
      { commandId: "page:0", kind: "withdrawal", amount: 100 },
      { commandId: "page:1", kind: "deposit", amount: 200 },
    ]);
    expect(result).toMatchObject({ _tag: "CompletedDeliver" });
    expect((result as { outcomes: unknown }).outcomes).toEqual([
      { commandId: "page:0", result: "Denied", reason: Option.some("MfaRequired") },
      { commandId: "page:1", result: "Rejected", reason: Option.some("NotOpen") },
    ]);
  }).pipe(Effect.provide(Client)),
);
