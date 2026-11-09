import type * as ec2 from "@distilled.cloud/aws/ec2";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** No managed prefix list by that name exists in the region. */
export class ManagedPrefixListNotFound extends Data.TaggedError(
  "AWS.EC2.ManagedPrefixListNotFound",
)<{
  readonly message: string;
}> {}

/**
 * The `DescribeManagedPrefixLists`-backed lookup of a prefix list by name
 * (IAM action `ec2:DescribeManagedPrefixLists`, granted on `*`). Returns the
 * prefix list, or `undefined` when none has that name. AWS-managed lists
 * have a different ID in every region, so look them up by name: CloudFront's
 * origin-facing addresses are `com.amazonaws.global.cloudfront.origin-facing`.
 *
 * As a **data source**, invoke it at plan time via {@link getManagedPrefixList}
 * — the result is an `Output` resolved during plan/deploy. As a **runtime
 * binding**, bind it inside a Function with
 * `Effect.provide(AWS.EC2.GetManagedPrefixListHttp)`.
 * ### Looking Up Prefix Lists
 * **Example:** Allow CloudFront to reach a load balancer
 * ```typescript
 * const group = yield* AWS.EC2.SecurityGroup("LoadBalancer", {
 *   vpcId: network.vpcId,
 *   ingress: [
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 80,
 *       toPort: 80,
 *       prefixListId: AWS.EC2.managedPrefixListId(
 *         "com.amazonaws.global.cloudfront.origin-facing",
 *       ),
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface GetManagedPrefixList extends Binding.Service<
  GetManagedPrefixList,
  "AWS.EC2.GetManagedPrefixList",
  (
    name: string,
  ) => Effect.Effect<
    () => Effect.Effect<ec2.ManagedPrefixList | undefined, ec2.DescribeManagedPrefixListsError>
  >
> {}

export const GetManagedPrefixList = Binding.Service<GetManagedPrefixList>(
  "AWS.EC2.GetManagedPrefixList",
);

/**
 * Plan-time prefix list lookup by name: an `Output` of the list, or
 * `undefined` when none has that name.
 */
export const getManagedPrefixList = <Req = never>(
  name: Input<string> | Effect.Effect<string, never, Req>,
) => GetManagedPrefixList.execute<Req>(name);

/**
 * A managed prefix list's ID in the current region, by name, as an
 * `Output<string>`. A name with no list fails the plan.
 */
export const managedPrefixListId = (name: string) =>
  getManagedPrefixList(name).pipe(
    Output.mapEffect((list) =>
      list?.PrefixListId
        ? Effect.succeed(list.PrefixListId)
        : Effect.die(
            new ManagedPrefixListNotFound({ message: `No managed prefix list named ${name}` }),
          ),
    ),
  );
