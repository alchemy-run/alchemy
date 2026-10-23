import { rejectsListed } from "../src/rules/rejects-listed.ts";
import { bank, kennel, tester } from "./tester.ts";

const filename = bank("src/Account/Account.aggregate.ts");
const header = `import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { AccountOpened, AlreadyOpen, OpenAccount } from "./OpenAccount.command.ts";
import { MoneyWithdrawn, WithdrawMoney } from "./WithdrawMoney.command.ts";
import { CloseAccount } from "./CloseAccount.command.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { Frozen } from "./Frozen.rejection.ts";
`;
const aggregate = (decide: string, extra = "", rest = "") =>
  `${header}${extra}
export class Account extends Domain.Aggregate("Account", {
  commands: [OpenAccount, WithdrawMoney, CloseAccount],
  decide: { ${decide} },
  ${rest}
}) {}`;

tester.run("rejects-listed", rejectsListed, {
  valid: [
    {
      filename,
      code: aggregate(
        `OpenAccount: (s, cmd) => (s.open ? new AlreadyOpen() : [new AccountOpened({ owner: cmd.owner })]),
         WithdrawMoney: Effect.fn(function* (s, cmd) {
           if (!s.open) return yield* new NotOpen();
           return [new MoneyWithdrawn({ amount: cmd.amount })];
         }),
         CloseAccount: () => []`,
      ),
    },
    {
      // Through a helper that only builds listed rejections.
      filename,
      code: aggregate(
        `WithdrawMoney: (s) => mustBeOpen(s) ?? []`,
        `const mustBeOpen = (s) => (s.open ? undefined : new NotOpen());`,
      ),
    },
    {
      // A command declared in this file.
      filename,
      code: `${header}
export class Freeze extends Domain.Command("Freeze", { rejects: [Frozen, NotOpen] }) {}
export class Account extends Domain.Aggregate("Account", {
  decide: { Freeze: (s) => (s.frozen ? new Frozen() : s.open ? [] : new NotOpen()) },
}) {}`,
    },
    {
      // A decide branch for a command the rule cannot find is skipped.
      filename,
      code: aggregate(`Unknown: () => new Frozen()`),
    },
    {
      filename,
      code: aggregate(
        `OpenAccount: () => []`,
        "",
        `read: { rejects: [NotOpen], validate: Effect.fn(function* (_r, s) { if (!s.open) return yield* new NotOpen(); }) },`,
      ),
    },
  ],
  invalid: [
    {
      filename,
      code: aggregate(
        `OpenAccount: (s) => (s.frozen ? new Frozen() : s.open ? new AlreadyOpen() : [])`,
      ),
      errors: [
        { messageId: "unlisted", data: { owner: "OpenAccount", rejection: "Frozen", via: "" } },
      ],
    },
    {
      filename,
      code: aggregate(
        `WithdrawMoney: Effect.fn(function* (s) { const o = yield* authorized(s); return []; })`,
        `const authorized = Effect.fn(function* (s) { if (s.frozen) return yield* new Frozen(); return s; });`,
      ),
      errors: [
        {
          messageId: "unlisted",
          data: { owner: "WithdrawMoney", rejection: "Frozen", via: " (through `authorized`)" },
        },
      ],
    },
    {
      // A command without `rejects` never rejects.
      filename,
      code: aggregate(`CloseAccount: (s) => (s.open ? [] : new NotOpen())`),
      errors: [
        { messageId: "unlisted", data: { owner: "CloseAccount", rejection: "NotOpen", via: "" } },
      ],
    },
    {
      filename,
      code: `${header}
export class Freeze extends Domain.Command("Freeze", { rejects: [Frozen] }) {}
export class Account extends Domain.Aggregate("Account", {
  decide: { Freeze: (s) => (s.open ? [] : new NotOpen()) },
}) {}`,
      errors: [{ messageId: "unlisted", data: { owner: "Freeze", rejection: "NotOpen", via: "" } }],
    },
    {
      filename,
      code: aggregate(
        `OpenAccount: () => []`,
        "",
        `read: { rejects: [], validate: Effect.fn(function* (_r, s) { if (!s.open) return yield* new NotOpen(); }) },`,
      ),
      errors: [
        { messageId: "unlisted", data: { owner: "Account.read", rejection: "NotOpen", via: "" } },
      ],
    },
    {
      filename: bank("src/Account/Summary.view.ts"),
      code: `${header}
export class Summary extends Domain.View("Summary", {
  rejects: [],
  validate: Effect.fn(function* (_r, v) { if (!v) return yield* new NotOpen(); }),
}) {}`,
      errors: [
        { messageId: "unlisted", data: { owner: "Summary", rejection: "NotOpen", via: "" } },
      ],
    },
  ],
});

const domain = `import * as Domain from "@alchemy.run/domain";\n`;

// Kebab-case files and a grouped messages file: the command's `rejects` is read from it.
tester.run("rejects-listed (kebab, messages file)", rejectsListed, {
  valid: [
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${domain}import { FeedDog, NotHungry } from "./dog.messages.ts";
export class Dog extends Domain.Aggregate("Dog", { decide: { FeedDog: () => new NotHungry() } }) {}`,
    },
  ],
  invalid: [
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${domain}import { Asleep, FeedDog } from "./dog.messages";
export class Dog extends Domain.Aggregate("Dog", { decide: { FeedDog: () => new Asleep() } }) {}`,
      errors: [{ messageId: "unlisted", data: { owner: "FeedDog", rejection: "Asleep", via: "" } }],
    },
  ],
});
