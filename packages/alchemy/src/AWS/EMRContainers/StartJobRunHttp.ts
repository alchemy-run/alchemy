import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersVirtualClusterHttpBinding } from "./BindingHttp.ts";
import { StartJobRun } from "./StartJobRun.ts";

export const StartJobRunHttp = Layer.effect(
  StartJobRun,
  makeEMRContainersVirtualClusterHttpBinding({
    tag: "AWS.EMRContainers.StartJobRun",
    operation: emrc.startJobRun,
    actions: ["emr-containers:StartJobRun"],
  }),
);
