import type { AwsCredentialIdentity } from "@smithy/types";
import * as ServiceMap from "effect/ServiceMap";
import type { AccountID } from "./Account.ts";
import type { RegionID } from "./Region.ts";

export class StageConfig extends ServiceMap.Service<
  StageConfig,
  {
    account?: AccountID;
    region?: RegionID;
    profile?: string;
    credentials?: AwsCredentialIdentity;
    endpoint?: string;
  }
>()("StageConfig") {}
