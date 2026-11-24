import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { caseNames } from "../../Domain/vault/cases.ts";
import DomainVaultFunctionLive, { DomainVaultFunction } from "./fixtures/vault-handler.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const Stack = Alchemy.Stack(
  "DomainVaultStack",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DomainVaultFunction;
    return { url: fn.functionUrl.as<string>() };
  }).pipe(Effect.provide(DomainVaultFunctionLive)),
);

/** A cases route answered with something other than 200. */
class CasesRequestFailed extends Data.TaggedError("CasesRequestFailed")<{
  readonly status: number;
  readonly body: string;
}> {
  override get message() {
    return `HTTP ${this.status}: ${this.body.slice(0, 2000)}`;
  }
}

const passed = Object.fromEntries(caseNames.map((name) => [name, true]));

// A Vault's keys on AWS: kept in DynamoDB, wrapped under KMS or a root key of your own.
describe(
  "Domain Vault on AWS",
  {
    tags: [
      "provider:aws",
      "provider:aws:dynamodb",
      "provider:aws:kms",
      "provider:aws:lambda",
      "live",
    ],
  },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

    const cases = (pairing: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* HttpClient.get(`${url.replace(/\/+$/, "")}/cases/${pairing}`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.flatMap(res.text, (body) =>
                  Effect.fail(new CasesRequestFailed({ status: res.status, body })),
                ),
          ),
          // A fresh function URL and its role's policy take a while to serve.
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
        );
      });

    test(
      "keys in DynamoDB, wrapped under a KMS key",
      Effect.gen(function* () {
        expect(yield* cases("dynamo-kms")).toEqual(passed);
      }),
      { timeout: 180_000 },
    );
    test(
      "keys in DynamoDB, wrapped under a root key",
      Effect.gen(function* () {
        expect(yield* cases("dynamo-root")).toEqual(passed);
      }),
      { timeout: 180_000 },
    );
  },
);
