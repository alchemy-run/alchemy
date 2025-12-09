import type { Account } from "./account.ts";
import type { Region } from "./region.ts";

declare module "../stage.ts" {
  interface StageConfig {
    aws?: {
      profile?: string;
      account: Account.ID;
      region: Region.ID;
    };
  }
}
