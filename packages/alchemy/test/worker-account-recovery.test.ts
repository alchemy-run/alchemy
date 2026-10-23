import { describe, expect } from "alchemy-test";
import { Context, Effect, Layer } from "effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";

class CheckpointEnvironment extends Context.Service<
  CheckpointEnvironment,
  Effect.Effect<{ accountId: string }>
>()("Test.AccountRecoveryEnvironment") {}

describe("Worker account recovery", { tags: ["unit", "local"] }, () => {
  interface Worker extends Resource<
    "Cloudflare.Worker",
    { name: string },
    {
      workerName: string;
      workerId: string;
      accountId: string;
    }
  > {}
  const Worker = Resource<Worker>("Cloudflare.Worker");
  class Deleted extends Context.Service<Deleted, Worker["Attributes"][]>()(
    "AccountRecoveryDeleted",
  ) {}
  const currentAccount = Effect.gen(function* () {
    const environment = yield* Effect.serviceOption(CheckpointEnvironment);
    if (Option.isNone(environment)) return yield* Effect.die("Test account was not provided");
    return (yield* environment.value).accountId;
  });
  const providers = Provider.succeed(Worker, {
    workerIdentity: {
      account: currentAccount,
      name: (_id, name) => (name ? Effect.succeed(name) : Effect.die("Test name required")),
      withAccount: (accountId, effect) =>
        currentAccount.pipe(
          Effect.andThen(
            effect.pipe(
              Effect.provideService(CheckpointEnvironment, Effect.succeed({ accountId })),
            ),
          ),
        ),
    },
    diff: () => Effect.succeed({ action: "noop" as const }),
    read: Effect.fn(function* ({ olds }) {
      const accountId = yield* currentAccount;
      return { workerName: olds.name, workerId: olds.name, accountId };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const accountId = yield* currentAccount;
      return { workerName: news.name, workerId: news.name, accountId };
    }),
    delete: Effect.fn(function* ({ output }) {
      (yield* Deleted).push(output);
    }),
  }).pipe(Layer.provideMerge(Layer.sync(Deleted, () => [])));
  const { test } = Test.make({ providers });
  const inAccount = (accountId: string) =>
    Effect.provideService(
      CheckpointEnvironment,
      Effect.succeed({
        accountId,
      }),
    );
  const seed = Effect.fn(function* (stack: { name: string; stage: string }) {
    const state = yield* yield* State;
    const base = {
      status: "created" as const,
      fqn: "Account",
      logicalId: "Account",
      instanceId: "oldest",
      resourceType: Worker.Type,
      namespace: undefined,
      props: { name: "oldest" },
      attr: { workerName: "oldest", workerId: "oldest", accountId: "account-a" },
      providerVersion: 0,
      bindings: [],
      downstream: [],
      workerIdentityResolved: true,
      workerWriteStarted: true,
    };
    yield* state.set({
      stack: stack.name,
      stage: stack.stage,
      fqn: "Account",
      value: {
        ...base,
        status: "replaced",
        instanceId: "current",
        props: { name: "current" },
        attr: { workerName: "current", workerId: "current", accountId: "account-b" },
        workerAccountId: "account-b",
        deleteFirst: false,
        old: {
          ...base,
          status: "replacing",
          instanceId: "pending",
          props: { name: "pending" },
          attr: { workerName: "pending", workerId: "pending", accountId: "account-a" },
          deleteFirst: false,
          old: base,
        },
      } as ResourceState,
    });
  });

  test.provider("quarantined cleanup stays in the account of the interrupted attempt", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* seed(stack);
      yield* stack.deploy(Worker("Account", { name: "current" })).pipe(inAccount("account-b"));
      const deleted = yield* Deleted;
      expect(deleted.map((value) => [value.workerName, value.accountId]).sort()).toEqual([
        ["oldest", "account-a"],
        ["pending", "account-a"],
      ]);
      const state = yield* yield* State;
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Account" });
      expect((row as ResourceState).workerAccountId).toBe("account-b");
      yield* stack.destroy().pipe(inAccount("account-b"));
      expect(deleted.at(-1)?.accountId).toBe("account-b");
    }),
  );
  test.provider("quarantined cleanup retains its account when credentials fail", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* seed(stack);
      const result = yield* stack
        .deploy(Worker("Account", { name: "current" }))
        .pipe(
          Effect.provideService(CheckpointEnvironment, Effect.die("Credentials unavailable")),
          Effect.exit,
        );
      expect(Exit.isFailure(result)).toBe(true);
      const state = yield* yield* State;
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Account" });
      expect((row as any).old.workerAccountId).toBe("account-a");
      yield* stack.destroy().pipe(inAccount("account-a"));
    }),
  );
});
