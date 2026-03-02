import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { StageConfig } from "./StageConfig.ts";

export class Account extends ServiceMap.Service<Account, string>()(
  "cloudflare/account-id",
) {}

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
      const { account = yield* Config.string("CLOUDFLARE_ACCOUNT_ID") } =
        yield* StageConfig;
      if (!account) {
        return yield* Effect.die("CLOUDFLARE_ACCOUNT_ID is not set");
      }
      return account;
    }),
  );
