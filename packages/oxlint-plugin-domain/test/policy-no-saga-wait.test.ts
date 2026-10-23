import { policyNoSagaWait } from "../src/rules/policy-no-saga-wait.ts";
import { bank, tester } from "./tester.ts";

const filename = bank("src/Transfer/TransferExecution.policy.ts");
const policy = (handler: string) => `import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { ExecuteTransfer } from "./ExecuteTransfer.saga.ts";
import { TransferRequested } from "./TransferRequested.ts";
export class TransferExecution extends Domain.Policy("TransferExecution", { from: Transfer, on: [TransferRequested] }) {}
export const TransferExecutionLive = TransferExecution.toLayer(
  Effect.gen(function* () {
    const executions = yield* ExecuteTransfer;
    return Effect.fn(function* ({ source, event }) {
      ${handler}
    });
  }),
);`;

tester.run("policy-no-saga-wait", policyNoSagaWait, {
  valid: [
    { filename, code: policy(`yield* executions.start(source, { amount: event.amount });`) },
    {
      filename,
      code: policy(`return yield* executions.get(source).signal(Decision, "approved");`),
    },
    {
      filename,
      code: policy(
        `const run = yield* executions.start(source, {}); yield* Effect.log(run.executionId);`,
      ),
    },
    // `.result` of something that is not a saga run.
    { filename, code: policy(`const r = yield* fraud.score({}); if (r.result > 1) return;`) },
    // A saga may wait.
    {
      filename: bank("src/Transfer/ExecuteTransfer.saga.ts"),
      code: `export const run = Effect.fn(function* () { const d = yield* DurableDeferred.await(Decision); });`,
    },
  ],
  invalid: [
    {
      filename,
      code: policy(
        `const run = yield* executions.start(source, {}); const out = yield* run.result;`,
      ),
      errors: [{ messageId: "result", data: { saga: "ExecuteTransfer" } }],
    },
    {
      filename,
      code: policy(`yield* executions.get(source).result;`),
      errors: [{ messageId: "result" }],
    },
    {
      filename,
      code: policy(`const out = yield* (yield* executions.start(source, {})).result;`),
      errors: [{ messageId: "result" }],
    },
    {
      filename,
      code: policy(`const decision = yield* DurableDeferred.await(Decision);`),
      errors: [{ messageId: "await" }],
    },
  ],
});
