import { deterministicCommandIds } from "../src/rules/deterministic-command-ids.ts";
import { tester } from "./tester.ts";

const policy = (handler: string, extra = "") => `import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
${extra}
export class Provisioning extends Domain.Policy("Provisioning", { from: Customer, on: [CustomerRegistered] }) {}
export const ProvisioningLive = Provisioning.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event, envelope }) {
      ${handler}
    });
  }),
);`;

tester.run("deterministic-command-ids", deterministicCommandIds, {
  valid: [
    policy(
      `yield* accounts.send(mainAccountId(source.id), new OpenAccount({ owner: event.name }));`,
    ),
    policy(
      `yield* accounts.send(source, new OpenAccount({}), { commandId: \`\${envelope.stream}:\${envelope.seq}\` });`,
    ),
    policy(`yield* accounts.send(source, new OpenAccount({}), { commandId: event.requestId });`),
    // Outside a handler (e.g. an Api client in the server) a random id is fine.
    `const id = crypto.randomUUID();\nexport const go = bank.OpenAccount({ target: id });`,
    // A projection keyed by stream:seq.
    `import * as Domain from "@alchemy.run/domain";
export class Ledger extends Domain.Projection("Ledger", { from: [Account], key: Account, on: [] }) {}
export const LedgerLive = Ledger.toLayer(Effect.gen(function* () {
  return Effect.fn(function* (batch) { yield* store.record(batch.map(({ envelope }) => ({ id: \`\${envelope.stream}:\${envelope.seq}\` }))); });
}), { batch: { size: 100 } });`,
  ],
  invalid: [
    {
      code: policy(
        `yield* accounts.send(AccountId.make(crypto.randomUUID()), new OpenAccount({}));`,
      ),
      errors: [
        { messageId: "random", data: { handler: "Provisioning", what: "crypto.randomUUID()" } },
      ],
    },
    {
      code: policy(
        `yield* accounts.send(source, new OpenAccount({}), { commandId: String(Date.now()) });`,
      ),
      errors: [{ messageId: "random", data: { handler: "Provisioning", what: "Date.now()" } }],
    },
    {
      code: policy(`yield* accounts.send(source, new OpenAccount({ openedAt: new Date() }));`),
      errors: [{ messageId: "random" }],
    },
    {
      code: policy(
        `yield* accounts.send(source, new OpenAccount({}), { commandId: "open-main" });`,
      ),
      errors: [{ messageId: "constant", data: { handler: "Provisioning" } }],
    },
    {
      code: policy(
        `yield* accounts.send(source, new OpenAccount({}), { commandId: \`open-main\` });`,
      ),
      errors: [{ messageId: "constant" }],
    },
    {
      // Through a local helper.
      code: policy(
        `yield* accounts.send(freshId(), new OpenAccount({}));`,
        `const freshId = () => \`a-\${Math.random()}\`;`,
      ),
      errors: [{ messageId: "random", data: { handler: "Provisioning", what: "Math.random()" } }],
    },
    {
      code: `import * as Domain from "@alchemy.run/domain";
export class Ledger extends Domain.Projection("Ledger", { from: [Account], key: Account, on: [] }) {}
export const LedgerLive = Ledger.toLayer(Effect.gen(function* () {
  return Effect.fn(function* (batch) { yield* store.record(batch.map(() => ({ id: crypto.randomUUID() }))); });
}));`,
      errors: [{ messageId: "random", data: { handler: "Ledger", what: "crypto.randomUUID()" } }],
    },
  ],
});
