import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  probeAccountName,
  probeCustomerBody,
  runLifecycle,
  waitUntilPartnerCustomerGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const probePartner = `${probeAccountName}/channelPartnerLinks/alchemy-missing`;

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsChannelPartnerLinksCustomers on a missing customer fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.getAccountsChannelPartnerLinksCustomers({
          name: `${probeAccountName}/customers/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CLOUDCHANNEL)(
  "createAccountsChannelPartnerLinksCustomers without Cloud Channel access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.createAccountsChannelPartnerLinksCustomers({
          parent: probePartner,
          body: probeCustomerBody,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a channel partner customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const partner =
        process.env.GOOGLE_CLOUDCHANNEL_PARTNER?.trim() ?? probePartner;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudchannel.ChannelPartnerLinksCustomer("Resold", {
            parent: partner,
            orgDisplayName: "Resold Corp",
          });
        }),
      );

      expect(created.name.includes("/customers/")).toEqual(true);
      expect(created.orgDisplayName).toEqual("Resold Corp");

      const fetched =
        yield* cloudchannel.getAccountsChannelPartnerLinksCustomers({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.orgDisplayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudchannel.ChannelPartnerLinksCustomer("Resold", {
            parent: partner,
            customerId: created.customerId,
            orgDisplayName: "Resold Corporation",
            domain: created.domain,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.orgDisplayName).toEqual("Resold Corporation");

      yield* stack.destroy();

      const gone = yield* waitUntilPartnerCustomerGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
