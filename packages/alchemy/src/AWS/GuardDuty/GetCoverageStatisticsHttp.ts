import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetCoverageStatistics } from "./GetCoverageStatistics.ts";

export const GetCoverageStatisticsHttp = Layer.effect(
  GetCoverageStatistics,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetCoverageStatistics",
    operation: guardduty.getCoverageStatistics,
    actions: ["guardduty:GetCoverageStatistics"],
  }),
);
