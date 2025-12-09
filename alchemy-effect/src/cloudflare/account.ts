import { Layer } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class Account extends Context.Tag("cloudflare/account-id")<
  Account,
  string
>() {
  static readonly fromEnv = Layer.effect(
    Account,
    Effect.gen(function* () {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) {
        return yield* Effect.die("CLOUDFLARE_ACCOUNT_ID is not set");
      }
      return accountId;
    }),
  );
}
