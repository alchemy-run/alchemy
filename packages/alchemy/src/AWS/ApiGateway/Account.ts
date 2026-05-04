import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryOnApiStatusUpdating } from "./common.ts";

export interface AccountProps {
  /**
   * IAM role ARN for API Gateway to push logs to CloudWatch.
   */
  cloudwatchRoleArn?: string;
}

export interface Account extends Resource<
  "AWS.ApiGateway.Account",
  AccountProps,
  {
    cloudwatchRoleArn: string | undefined;
    /**
     * True when this stack last applied a desired `cloudwatchRoleArn` (including clearing it).
     * Used so destroy does not remove a role the stack never configured.
     */
    managesCloudwatchRoleArn: boolean;
  },
  never,
  Providers
> {}

/**
 * Account-level settings for Amazon API Gateway in the current region
 * (CloudWatch logging role, etc.).
 *
 * @section Account settings
 * @example Set logging role
 * ```typescript
 * yield* ApiGateway.Account("Account", {
 *   cloudwatchRoleArn: role.roleArn,
 * });
 * ```
 */
const AccountResource = Resource<Account>("AWS.ApiGateway.Account");

export { AccountResource as Account };

export const AccountProvider = () =>
  Provider.effect(
    AccountResource,
    Effect.gen(function* () {
      return {
        diff: Effect.fn(function* ({ news: newsIn, olds, output }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as AccountProps;
          const prevManages = output?.managesCloudwatchRoleArn ?? false;
          const nextManages = news.cloudwatchRoleArn !== undefined;
          if (nextManages) {
            if (news.cloudwatchRoleArn !== olds.cloudwatchRoleArn) {
              return { action: "update" } as const;
            }
          } else if (prevManages) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          const a = yield* ag
            .getAccount({})
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          return {
            cloudwatchRoleArn: a?.cloudwatchRoleArn,
            managesCloudwatchRoleArn: output?.managesCloudwatchRoleArn ?? false,
          };
        }),
        create: Effect.fn(function* ({ news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Account props were not resolved");
          }
          const news = newsIn as AccountProps;
          const manages = news.cloudwatchRoleArn !== undefined;
          const patches: ag.PatchOperation[] = [];
          if (manages) {
            if (news.cloudwatchRoleArn) {
              patches.push({
                op: "replace",
                path: "/cloudwatchRoleArn",
                value: news.cloudwatchRoleArn,
              });
            } else {
              patches.push({ op: "remove", path: "/cloudwatchRoleArn" });
            }
          }
          if (patches.length > 0) {
            yield* retryOnApiStatusUpdating(
              ag.updateAccount({ patchOperations: patches }),
            );
          }
          yield* session.note("Updated API Gateway account settings");
          const a = yield* ag.getAccount({});
          return {
            cloudwatchRoleArn: a.cloudwatchRoleArn,
            managesCloudwatchRoleArn: manages,
          };
        }),
        update: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Account props were not resolved");
          }
          const news = newsIn as AccountProps;
          let manages = output.managesCloudwatchRoleArn;
          if (news.cloudwatchRoleArn !== undefined) {
            manages = true;
            yield* retryOnApiStatusUpdating(
              ag.updateAccount({
                patchOperations: news.cloudwatchRoleArn
                  ? [
                      {
                        op: "replace",
                        path: "/cloudwatchRoleArn",
                        value: news.cloudwatchRoleArn,
                      },
                    ]
                  : [{ op: "remove", path: "/cloudwatchRoleArn" }],
              }),
            );
          } else {
            manages = false;
          }
          yield* session.note("Updated API Gateway account settings");
          const a = yield* ag.getAccount({});
          return {
            cloudwatchRoleArn: a.cloudwatchRoleArn,
            managesCloudwatchRoleArn: manages,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (output.managesCloudwatchRoleArn) {
            yield* retryOnApiStatusUpdating(
              ag
                .updateAccount({
                  patchOperations: [
                    { op: "remove", path: "/cloudwatchRoleArn" },
                  ],
                })
                .pipe(
                  Effect.catchTag("BadRequestException", () => Effect.void),
                ),
            );
            yield* session.note("Cleared API Gateway account CloudWatch role");
          }
        }),
      };
    }),
  );
