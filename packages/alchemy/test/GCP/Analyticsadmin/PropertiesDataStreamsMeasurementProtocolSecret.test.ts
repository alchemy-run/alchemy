import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as analytics from "@distilled.cloud/gcp/analyticsadmin_v1beta";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  resolveAccountName,
  runLifecycle,
  waitUntilPropertyGone,
  waitUntilSecretGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getPropertiesDataStreamsMeasurementProtocolSecrets on a missing secret fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.getPropertiesDataStreamsMeasurementProtocolSecrets({
          name: "properties/0/dataStreams/0/measurementProtocolSecrets/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANALYTICSADMIN)(
  "createPropertiesDataStreamsMeasurementProtocolSecrets without Analytics Admin access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.createPropertiesDataStreamsMeasurementProtocolSecrets({
          parent: "properties/0/dataStreams/0",
          body: { displayName: "Alchemy Analyticsadmin Secret Probe" },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a measurement protocol secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* resolveAccountName();
      expect(account).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            displayName: "Alchemy secret property",
            timeZone: "America/Chicago",
          });
          const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
            parent: property.name,
            type: "WEB_DATA_STREAM",
            displayName: "www",
            webStreamData: { defaultUri: "https://example.com" },
          });
          const secret =
            yield* GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret(
              "Ingest",
              {
                parent: stream.name,
                displayName: "server ingest",
              },
            );
          return { property, stream, secret };
        }),
      );

      expect(created.secret.name).toContain("/measurementProtocolSecrets/");
      expect(created.secret.displayName).toEqual("server ingest");
      expect(created.secret.secretValue).toEqual(expect.any(String));

      const fetched =
        yield* analytics.getPropertiesDataStreamsMeasurementProtocolSecrets({
          name: created.secret.name,
        });
      expect(fetched.name).toEqual(created.secret.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("server ingest");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            propertyId: created.property.propertyId,
            displayName: "Alchemy secret property",
            timeZone: "America/Chicago",
          });
          const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
            parent: property.name,
            dataStreamId: created.stream.dataStreamId,
            type: "WEB_DATA_STREAM",
            displayName: "www",
            webStreamData: { defaultUri: "https://example.com" },
          });
          const secret =
            yield* GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret(
              "Ingest",
              {
                parent: stream.name,
                secretId: created.secret.secretId,
                displayName: "server ingest 2026",
              },
            );
          return { property, stream, secret };
        }),
      );

      expect(updated.secret.name).toEqual(created.secret.name);
      expect(updated.secret.displayName).toEqual("server ingest 2026");

      yield* stack.destroy();

      const secretGone = yield* waitUntilSecretGone(created.secret.name);
      expect(secretGone).toEqual("gone");
      const propertyGone = yield* waitUntilPropertyGone(created.property.name);
      expect(propertyGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
