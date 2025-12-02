import type { AccountID } from "./account.ts";
import type { RegionID } from "./region.ts";

declare module "../stage.ts" {
  interface StageConfig {
    aws?: {
      account: AccountID;
      region: RegionID;
    };
  }
}
