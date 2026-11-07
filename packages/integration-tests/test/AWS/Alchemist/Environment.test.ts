import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { resolveAwsEnvironment } from "../../../../aws/src/Alchemist/Environment.ts";

const awsRuntime = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  SecureRandom.layerWebCrypto,
);

it.effect(
  "uses env-file credentials before an invalid AWS CLI profile",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-aws-bootstrap-env-" });
        const envFile = path.join(dir, "credentials.env");
        yield* fs.writeFileString(
          envFile,
          [
            "AWS_ACCESS_KEY_ID=fake-env-access-key",
            "AWS_SECRET_ACCESS_KEY=fake-env-secret-key",
            "AWS_SESSION_TOKEN=fake-env-session-token",
            "AWS_ACCOUNT_ID=123456789012",
            "AWS_REGION=us-west-2",
            "ALCHEMY_PROFILE=not-an-aws-cli-profile",
          ].join("\n"),
        );

        const previousAlchemyHome = process.env.ALCHEMY_HOME;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.ALCHEMY_HOME = dir;
          }),
          () =>
            Effect.sync(() => {
              if (previousAlchemyHome === undefined) delete process.env.ALCHEMY_HOME;
              else process.env.ALCHEMY_HOME = previousAlchemyHome;
            }),
        );

        const resolved = yield* resolveAwsEnvironment({
          profile: "missing-aws-cli-profile",
          region: "eu-central-1",
          envFile,
        }).pipe(Effect.provide(ProfileStoreLive));
        expect(resolved.accountId).toBe("123456789012");
        expect(resolved.region).toBe("eu-central-1");
        expect(resolved.profile).toBeUndefined();
        const credentials = yield* resolved.credentials;
        expect(credentials.region).toBe("eu-central-1");
        expect(credentials.sessionToken).toBeDefined();
      }),
    ).pipe(Effect.provide(awsRuntime)),
  { tags: ["unit", "provider:aws", "local"], exclusive: true },
);

it.live(
  "uses the explicit AWS CLI profile when environment credentials are incomplete",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-aws-bootstrap-home-" });
        const awsDir = path.join(home, ".aws");
        yield* fs.makeDirectory(awsDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(awsDir, "config"),
          `[profile cli-fallback]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\nsso_account_id = 210987654321\nsso_role_name = AdministratorAccess\nregion = ap-southeast-2\n`,
        );
        const envFile = path.join(home, "empty.env");
        yield* fs.writeFileString(envFile, "");

        const previousHome = process.env.HOME;
        const previousAlchemyHome = process.env.ALCHEMY_HOME;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.HOME = home;
            process.env.ALCHEMY_HOME = home;
          }),
          () =>
            Effect.sync(() => {
              if (previousHome === undefined) delete process.env.HOME;
              else process.env.HOME = previousHome;
              if (previousAlchemyHome === undefined) delete process.env.ALCHEMY_HOME;
              else process.env.ALCHEMY_HOME = previousAlchemyHome;
            }),
        );

        const resolved = yield* resolveAwsEnvironment({
          profile: "cli-fallback",
          envFile,
        }).pipe(Effect.provide(ProfileStoreLive));
        expect(resolved.accountId).toBe("210987654321");
        expect(resolved.region).toBe("ap-southeast-2");
        expect(resolved.profile).toBe("cli-fallback");
      }),
    ).pipe(Effect.provide(awsRuntime)),
  { tags: ["unit", "provider:aws", "local"], exclusive: true },
);
