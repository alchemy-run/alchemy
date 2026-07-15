import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsEndpointScopedHttpBinding } from "./BindingHttp.ts";
import { DescribeRefreshSchemasStatus } from "./DescribeRefreshSchemasStatus.ts";

export const DescribeRefreshSchemasStatusHttp = Layer.effect(
  DescribeRefreshSchemasStatus,
  makeDmsEndpointScopedHttpBinding<
    dms.DescribeRefreshSchemasStatusMessage,
    dms.DescribeRefreshSchemasStatusResponse,
    dms.DescribeRefreshSchemasStatusError
  >({
    tag: "AWS.DMS.DescribeRefreshSchemasStatus",
    actions: ["dms:DescribeRefreshSchemasStatus"],
    operation: dms.describeRefreshSchemasStatus,
  }),
);
