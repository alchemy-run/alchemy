#!/usr/bin/env bun
// Out-of-band probe of the LicenseManager negative-path calls used by the
// Bindings fixture — prints the exact typed tag (or unknown error) each
// call produces so the fixture's catch sets can be corrected.
import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as licensemanager from "@distilled.cloud/aws/license-manager";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const probe = (name: string, eff: Effect.Effect<any, any, any>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(eff);
    if (Result.isSuccess(result)) {
      console.log(`${name}: OK`, JSON.stringify(result.success).slice(0, 200));
    } else {
      const e = result.failure as any;
      console.log(
        `${name}: FAIL tag=${e?._tag} message=${String(e?.message).slice(0, 300)}`,
      );
      if (e?._tag === "UnknownAwsError") {
        console.log(
          `${name}: RAW ${JSON.stringify({ ...e }, null, 0).slice(0, 600)}`,
        );
      }
    }
  });

const main = Effect.gen(function* () {
  yield* probe(
    "checkoutLicense(bogus)",
    licensemanager.checkoutLicense({
      ProductSKU: "00000000-0000-0000-0000-000000000000",
      CheckoutType: "PROVISIONAL",
      KeyFingerprint: "aws:294406891311:AWS/KeyManagement:v1",
      Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
      ClientToken: "00000000-0000-4000-8000-000000000000",
    }),
  );
  yield* probe(
    "getAccessToken(bogus)",
    licensemanager.getAccessToken({ Token: "not-a-valid-refresh-token" }),
  );
  yield* probe(
    "getLicense(bogus)",
    licensemanager.getLicense({
      LicenseArn:
        "arn:aws:license-manager::111111111111:license:l-00000000000000000000000000000000",
    }),
  );
  yield* probe(
    "getGrant(bogus)",
    licensemanager.getGrant({
      GrantArn:
        "arn:aws:license-manager::111111111111:grant:g-00000000000000000000000000000000",
    }),
  );
  yield* probe(
    "listLicenseSpecificationsForResource(bogus)",
    licensemanager.listLicenseSpecificationsForResource({
      ResourceArn: "arn:aws:ec2:us-east-1::image/ami-00000000000000000",
    }),
  );
  yield* probe(
    "listResourceInventory",
    licensemanager.listResourceInventory({}),
  );
  yield* probe("getServiceSettings", licensemanager.getServiceSettings({}));
  yield* probe("listLicenses", licensemanager.listLicenses({}));
  yield* probe("listReceivedGrants", licensemanager.listReceivedGrants({}));
});

const options = { providers: AWS.providers() };
await Core.run(Core.withProviders(main, options, "probe-lm") as any, options);
