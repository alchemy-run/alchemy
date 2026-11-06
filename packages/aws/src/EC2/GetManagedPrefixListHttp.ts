import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GetManagedPrefixList } from "./GetManagedPrefixList.ts";

// Bespoke (not the shared scaffold): the binding is account-scoped — there
// is no resource to bind, only a name to look up.
export const GetManagedPrefixListHttp = Layer.effect(
  GetManagedPrefixList,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describeManagedPrefixLists = yield* AWSBindings.withCredentials(
      ec2.describeManagedPrefixLists,
    );

    return Effect.fn(function* (name: string) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.EC2.GetManagedPrefixList`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["ec2:DescribeManagedPrefixLists"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.EC2.GetManagedPrefixList")(function* () {
        const response = yield* describeManagedPrefixLists({
          Filters: [{ Name: "prefix-list-name", Values: [name] }],
        });
        return response.PrefixLists?.[0];
      });
    });
  }),
);
