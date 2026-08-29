import { AWSEnvironment } from "@/AWS/Environment.ts";
import {
  FLOCI_ACCOUNT_ID,
  FLOCI_REGION,
  FlociProfileService,
  flociServices,
  resolveFlociProfile,
} from "@/AWS/Local/FlociServices.ts";
import { Endpoint } from "@distilled.cloud/aws";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "alchemy-test";

const readProfile = (profile: Parameters<typeof flociServices>[0]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(flociServices(profile));
    const endpoint = Context.get(context, Endpoint.Endpoint);
    const region = Context.get(context, Region);
    const credentials = Context.get(context, Credentials);
    const environment = Context.get(context, AWSEnvironment);
    return {
      endpoint: yield* endpoint,
      region: yield* region,
      credentials: yield* credentials,
      environment: yield* environment,
    };
  });

const readContextualProfile = (profile: Parameters<typeof flociServices>[0]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      flociServices().pipe(
        Layer.provide(Layer.succeed(FlociProfileService, profile ?? {})),
      ),
    );
    const environment = Context.get(context, AWSEnvironment);
    return yield* environment;
  });

describe("Floci local provider profiles", () => {
  it.effect("keeps the standalone Floci identity defaults", () =>
    Effect.gen(function* () {
      const profile = resolveFlociProfile();
      expect(profile.accountId).toBe(FLOCI_ACCOUNT_ID);
      expect(profile.region).toBe(FLOCI_REGION);
      expect(profile.endpoint).toBe("http://localhost:4566");
      expect(Redacted.value(profile.credentials.accessKeyId)).toBe("test");
      expect(Redacted.value(profile.credentials.secretAccessKey)).toBe("test");
    }),
  );

  it.effect(
    "projects two profiles without process-global environment mutation",
    () =>
      Effect.gen(function* () {
        const a = yield* readProfile({
          endpoint: "http://localhost:4567",
          region: "eu-west-1",
          accountId: "123456789012",
          credentials: {
            accessKeyId: "123456789012",
            secretAccessKey: "profile-a-secret",
          },
          autoStart: false,
        });
        const b = yield* readProfile({
          endpoint: "http://localhost:4568",
          region: "ap-southeast-1",
          accountId: "210987654321",
          credentials: {
            accessKeyId: "210987654321",
            secretAccessKey: "profile-b-secret",
          },
          autoStart: false,
        });

        expect(a.endpoint).toBe("http://localhost:4567");
        expect(a.region).toBe("eu-west-1");
        expect(a.environment.accountId).toBe("123456789012");
        expect(a.environment.endpoint).toBe("http://localhost:4567");
        expect(Redacted.value(a.credentials.accessKeyId)).toBe("123456789012");
        expect(Redacted.value(a.credentials.secretAccessKey)).toBe(
          "profile-a-secret",
        );

        expect(b.endpoint).toBe("http://localhost:4568");
        expect(b.region).toBe("ap-southeast-1");
        expect(b.environment.accountId).toBe("210987654321");
        expect(b.environment.endpoint).toBe("http://localhost:4568");
        expect(Redacted.value(b.credentials.accessKeyId)).toBe("210987654321");
        expect(Redacted.value(b.credentials.secretAccessKey)).toBe(
          "profile-b-secret",
        );
      }),
  );

  it.effect("reads the selected profile from provider context", () =>
    Effect.gen(function* () {
      const environment = yield* readContextualProfile({
        endpoint: "http://localhost:4571",
        region: "eu-central-1",
        accountId: "333333333333",
        autoStart: false,
      });
      expect(environment.endpoint).toBe("http://localhost:4571");
      expect(environment.region).toBe("eu-central-1");
      expect(environment.accountId).toBe("333333333333");
    }),
  );

  it.effect(
    "accepts an owned Floci lifecycle profile without requiring credentials",
    () =>
      Effect.gen(function* () {
        const profile = resolveFlociProfile({
          endpoint: "http://localhost:4570",
          accountId: "111111111111",
          floci: {
            image: "floci:test",
            containerName: "alchemy-floci-test",
            env: { FLOCI_TEST_PROFILE: "one" },
          },
          autoStart: false,
        });
        expect(profile.floci?.image).toBe("floci:test");
        expect(profile.floci?.containerName).toBe("alchemy-floci-test");
        expect(profile.floci?.env).toEqual({ FLOCI_TEST_PROFILE: "one" });
        expect(Redacted.value(profile.credentials.accessKeyId)).toBe(
          "111111111111",
        );
      }),
  );
});
