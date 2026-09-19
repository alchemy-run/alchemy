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
  waitUntilDataStreamGone,
  waitUntilPropertyGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getPropertiesDataStreams on a missing stream fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.getPropertiesDataStreams({
          name: "properties/0/dataStreams/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANALYTICSADMIN)(
  "createPropertiesDataStreams without Analytics Admin access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.createPropertiesDataStreams({
          parent: "properties/0",
          body: {
            type: "WEB_DATA_STREAM",
            displayName: "Alchemy Analyticsadmin Stream Probe",
            webStreamData: { defaultUri: "https://example.com" },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data stream",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* resolveAccountName();
      expect(account).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            displayName: "Alchemy stream property",
            timeZone: "America/Chicago",
          });
          const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
            parent: property.name,
            type: "WEB_DATA_STREAM",
            displayName: "www",
            webStreamData: { defaultUri: "https://example.com" },
          });
          return { property, stream };
        }),
      );

      expect(created.stream.name).toContain("/dataStreams/");
      expect(created.stream.displayName).toEqual("www");
      expect(created.stream.webStreamData?.defaultUri).toEqual(
        "https://example.com",
      );

      const fetched = yield* analytics.getPropertiesDataStreams({
        name: created.stream.name,
      });
      expect(fetched.name).toEqual(created.stream.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("www");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            propertyId: created.property.propertyId,
            displayName: "Alchemy stream property",
            timeZone: "America/Chicago",
          });
          const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
            parent: property.name,
            dataStreamId: created.stream.dataStreamId,
            type: "WEB_DATA_STREAM",
            displayName: "www app",
            webStreamData: { defaultUri: "https://example.com/app" },
          });
          return { property, stream };
        }),
      );

      expect(updated.stream.name).toEqual(created.stream.name);
      expect(updated.stream.displayName).toEqual("www app");
      expect(updated.stream.webStreamData?.defaultUri).toEqual(
        "https://example.com/app",
      );

      yield* stack.destroy();

      const streamGone = yield* waitUntilDataStreamGone(created.stream.name);
      expect(streamGone).toEqual("gone");
      const propertyGone = yield* waitUntilPropertyGone(created.property.name);
      expect(propertyGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
