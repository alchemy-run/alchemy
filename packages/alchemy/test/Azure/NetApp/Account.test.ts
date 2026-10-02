import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    return yield* netapp.GetAccount({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
    });
  });

const program = (props: { location: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const account = yield* Azure.NetApp.Account("Files", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
    });
    return { group, account };
  });

// The account is free and provisions in under a minute, but free-trial
// subscriptions cannot create NetApp accounts in any region
// (`ResourceRestriction`, see the probe below).
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a netapp account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({ location: LOCATION, tags: { env: "test" } }),
      );
      expect(account.location).toEqual(LOCATION);
      expect(account.tags).toEqual({ env: "test" });
      const observed = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Files");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ location: LOCATION, tags: { env: "prod" } }),
      );
      expect(updated.account.accountId).toEqual(account.accountId);
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: location.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod" } }),
      );
      expect(replaced.account.accountName).not.toEqual(account.accountName);
      const moved = yield* getAccount(
        group.resourceGroupName,
        replaced.account.accountName,
      );
      expect(moved.location).toEqual("westus2");
      expect(
        yield* waitGone(
          getAccount(group.resourceGroupName, account.accountName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAccount(group.resourceGroupName, replaced.account.accountName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the free-trial subscription is refused NetApp accounts with
// the typed `ResourceRestriction` error, which blocks every NetApp resource.
test.provider.skipIf(runPaidOnly)(
  "a free-trial subscription is refused netapp accounts with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: LOCATION,
          });
          return { group };
        }),
      );
      const error = yield* netapp
        .AccountsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          accountName: "probe",
          location: LOCATION,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NetAppCreationRestricted");
      expect(
        yield* waitGone(getAccount(group.resourceGroupName, "probe")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
