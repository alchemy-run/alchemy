import type { AccountID } from "./account.ts";
import type { RegionID } from "./region.ts";
import type { AwsCredentialIdentity } from "@smithy/types";

export interface AwsStageConfig {
  account?: AccountID;
  region?: RegionID;
  profile?: string;
  credentials?: AwsCredentialIdentity;
}

declare module "../stage.ts" {
  interface StageConfig {
    aws?: AwsStageConfig;
  }
}
