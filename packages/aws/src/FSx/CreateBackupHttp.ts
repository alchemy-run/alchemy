import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { makeFSxFileSystemHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeFSxFileSystemHttpBinding({
    tag: "AWS.FSx.CreateBackup",
    operation: fsx.createBackup,
    actions: ["fsx:CreateBackup", "fsx:TagResource"],
    // CreateBackup also authorizes on the new backup's own ARN, which is
    // unknowable at deploy time.
    extraResourceArns: [AWSBindings.partitionArn("fsx:*:*:backup/*")],
  }),
);
