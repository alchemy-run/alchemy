import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Foldkit from "../src/Foldkit.ts";
import { CounterApi, CounterId, Limit, Unauthenticated } from "./Counter.ts";

const Counter = Foldkit.commands(CounterApi);
const target = CounterId.make("one");
Counter.Reset({ target, input: {}, commandId: "page:0" });
Counter.Increment({ target, input: { amount: 1 }, commandId: "page:1" });
// @ts-expect-error the target is branded
Counter.Increment({ target: "one", input: { amount: 1 }, commandId: "page:1" });
// @ts-expect-error input uses the decoded side of the transform
Counter.Increment({ target, input: { amount: "1" }, commandId: "page:1" });
// @ts-expect-error required command input cannot be omitted
Counter.Increment({ target, commandId: "page:1" });

const check = (message: typeof Counter.Message.Type) =>
  Counter.Message.match<void>(message, {
    SucceededIncrement: ({ reply }) => {
      const total: number = reply.total;
      void total;
    },
    FailedIncrement: ({ failure }) => {
      if (failure._tag === "Rejected") {
        const rejection: typeof Limit.Type = failure.rejection;
        void rejection;
      }
    },
    SucceededReset: ({ reply }) => {
      const empty: void = reply;
      void empty;
    },
    FailedReset: ({ failure }) => {
      if (failure._tag === "Denied") {
        const denied: Unauthenticated = failure.error;
        void denied;
      }
    },
  });
const schema: Schema.Top = Counter.Message;
const requirements: Effect.Effect<
  typeof Counter.Message.Type,
  never,
  typeof CounterApi.Client.Identifier
> = Counter.Increment({ target, input: { amount: 1 }, commandId: "page:1" }).effect;
void check;
void schema;
void requirements;
