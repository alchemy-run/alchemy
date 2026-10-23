# @alchemy.run/oxlint-plugin-domain

oxlint rules for [`@alchemy.run/domain`](../domain) models. They check the rules of the `alchemy-domain` skill (`packages/domain/skills/alchemy-domain`) at lint time.

## Enable it

```ts
// oxlint.config.ts
import { defineConfig } from "oxlint";
import { domainRules, serverRules } from "@alchemy.run/oxlint-plugin-domain/configs";

export default defineConfig({
  jsPlugins: ["@alchemy.run/oxlint-plugin-domain"],
  overrides: [
    { files: ["packages/domain/src/**"], rules: domainRules },
    { files: ["packages/server/src/**"], rules: serverRules },
  ],
});
```

Rule ids use the plugin name `alchemy-domain` (`"alchemy-domain/no-throw": "error"`). Turn single rules off or change their level in `rules` as usual.

## Rules

| Rule | What it checks | Source |
| --- | --- | --- |
| `domain-imports` | The domain package imports only `@alchemy.run/domain`, `effect` and its own files (type-only `alchemy` imports are allowed). Options: `allow`, `allowTypes`, `allowPaths` (directories a relative import may leave the package for). | SKILL.md, Conventions |
| `pure-decide-evolve` | An aggregate's `decide` / `evolve` / `reply` and a view's `evolve` / `emit` / `computed` / `keyOf` read no clock, randomness, `process`, `fetch`, timers or `console`, also inside local helpers they call. | SKILL.md, Rules |
| `evolve-only-applies` | An `evolve` handler returns state: no Effect, generator or `async`, no rejection, no new event. | SKILL.md, Rules |
| `rejects-listed` | Each rejection a `decide` handler builds is in its command's `rejects` (the command may be in another file). Same for a view's or an aggregate read's `validate`. | SKILL.md, Rules |
| `no-throw` | No `throw`. | SKILL.md, Rules |
| `no-cross-aggregate-import` | An aggregate does not import another aggregate (type-only imports are allowed). | SKILL.md, layout.md |
| `deterministic-command-ids` | A policy's or projection's `toLayer` reads no clock or randomness, and a `commandId` is not a constant. | SKILL.md, Rules |
| `policy-no-saga-wait` | A policy does not read a saga run's `result` or `DurableDeferred.await`. | SKILL.md, Rules |
| `block-file-name` | A block lives in `<Noun>.<kind>.ts`, named after the block; a kind-suffixed file declares a block of its kind. Options: `fileCase`, `messagesFile` (see below). | SKILL.md, Conventions |
| `one-block-per-file` | One block per file; events and rejections may join a command. Options: `fileCase`, `messagesFile`. | SKILL.md, Conventions |
| `aggregate-id-file` | `<Aggregate>.aggregate.ts` has a sibling `<Aggregate>.id.ts`, and takes its `id` from it. Option: `fileCase`. | SKILL.md, Conventions |
| `relative-import-extension` | Relative imports end in `.ts`. | layout.md |
| `no-barrel-file` | No file that only re-exports. | layout.md |
| `story-coverage` | Each command (or one of its events) and each rejection is built in a story of its package. | SKILL.md, Checklist; testing.md |
| `redacted-secrets` | A schema field named like a secret is `Schema.Redacted`. Options: `names`, `ignore`. | SKILL.md, Rules |
| `no-chained-provide` | One `Effect.provide` per effect. | SKILL.md, Rules |

### File names

`block-file-name`, `one-block-per-file` and `aggregate-id-file` take the same options:

- `fileCase`: `"pascal"` (default, `WithdrawMoney.command.ts`) or `"kebab"` (`withdraw-money.command.ts`, `account.id.ts`) for a repository whose files are kebab-case.
- `messagesFile`: a suffix, e.g. `"messages"`. Then `<noun>.messages.ts` may hold the commands, events and rejections of one aggregate together, and no other block.

```ts
const naming = ["warn", { fileCase: "kebab", messagesFile: "messages" }];
rules: {
  "alchemy-domain/block-file-name": naming,
  "alchemy-domain/one-block-per-file": naming,
  "alchemy-domain/aggregate-id-file": ["warn", { fileCase: "kebab" }],
}
```

oxlint JS rules see one file and no types. The rules that need a second file (`rejects-listed`, `evolve-only-applies`, `no-cross-aggregate-import`, `aggregate-id-file`, `story-coverage`) read it from disk and scan its text for the shapes the skill prescribes (`export class X extends Domain.Y(...)`).

## Test

```sh
pnpm -C packages/oxlint-plugin-domain test
```

The tests use oxlint's `RuleTester` on Node's test runner (`RuleTester` does not run on Bun).
