import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  callerObjectId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (expirationDate: string) =>
  Effect.gen(function* () {
    const { tenantId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.DataShare.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const share = yield* Azure.DataShare.Share("Share", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    // Targets the deploying service principal, so no email is sent.
    const invitation = yield* Azure.DataShare.Invitation("Invitation", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      share: share.shareName,
      targetActiveDirectoryId: tenantId,
      targetObjectId: yield* callerObjectId,
      expirationDate,
    });
    return { group, account, share, invitation };
  });

// Data Share objects are free; ~2 minutes.
test.provider(
  "create, replace, and delete an invitation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, share, invitation } = yield* stack.deploy(
        program("2099-01-01T00:00:00Z"),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* datashare.GetInvitation({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            shareName: share.shareName,
            invitationName: name,
          });
        });
      expect(invitation.invitationId).not.toEqual("");
      expect(invitation.invitationStatus).toEqual("Pending");
      const observed = yield* get(invitation.invitationName);
      expect(observed.properties?.invitationId).toEqual(invitation.invitationId);
      expect(observed.properties?.targetObjectId).toEqual(
        yield* callerObjectId,
      );

      // Replacement: invitations are immutable.
      const replaced = yield* stack.deploy(program("2098-01-01T00:00:00Z"));
      expect(replaced.invitation.invitationId).not.toEqual(
        invitation.invitationId,
      );
      expect(yield* waitGone(get(invitation.invitationName), 6)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.invitation.invitationName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
