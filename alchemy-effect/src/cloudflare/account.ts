import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { App } from "../app.ts";

export class Account extends Context.Tag("cloudflare/account-id")<
  Account,
  string
>() {}

export const fromEnv = () =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
      if (!accountId) {
        return yield* Effect.die("CLOUDFLARE_ACCOUNT_ID is not set");
      }
      return accountId;
    }),
  );

export const fromStageConfig = () =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const app = yield* App;
      const accountId =
        app.config.cloudflare?.account ??
        (yield* Config.string("CLOUDFLARE_ACCOUNT_ID"));
      if (!accountId) {
        return yield* Effect.die("CLOUDFLARE_ACCOUNT_ID is not set");
      }
      return accountId;
    }),
  );
