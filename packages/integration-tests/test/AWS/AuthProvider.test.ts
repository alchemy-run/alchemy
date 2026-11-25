import { applyEnvRegionOverride, parseAwsSsoLoginOutput } from "@alchemy.run/aws/AuthProvider";
import { describe, expect, it } from "@alchemy.run/test";
import { loadConfigProvider } from "alchemy/Util/ConfigProvider";
import { exec } from "alchemy/Util/exec";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

// Simulates credentials resolved from an SSO profile whose ~/.aws/config
// region differs from the region the user explicitly set in the environment.
const profileCreds = { accountId: "123456789012", region: "us-west-2" };

describe("aws-profile", { tags: ["unit", "provider:aws", "local"] }, () => {
  for (const { name, profileRegion, env, region } of [
    {
      name: "resolves credential_process without stored keys and prefers the profile region",
      profileRegion: "us-west-2",
      env: { AWS_DEFAULT_REGION: "eu-west-1" },
      region: "us-west-2",
    },
    {
      name: "keeps a China profile region when the default is commercial",
      profileRegion: "cn-north-1",
      env: { AWS_DEFAULT_REGION: "us-east-1" },
      region: "cn-north-1",
    },
    {
      name: "lets AWS_REGION override the profile region",
      profileRegion: "us-west-2",
      env: { AWS_REGION: "us-east-2" },
      region: "us-east-2",
    },
    {
      name: "uses AWS_DEFAULT_REGION when the profile has no region",
      profileRegion: undefined,
      env: { AWS_DEFAULT_REGION: "eu-west-1" },
      region: "eu-west-1",
    },
  ]) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-aws-profile-" });
        const helper = path.join(dir, "credentials.sh");
        const config = path.join(dir, "config");
        const credentials = path.join(dir, "credentials");
        yield* fs.writeFileString(
          helper,
          `printf '%s' '{"Version":1,"AccessKeyId":"process-key","SecretAccessKey":"process-secret","SessionToken":"process-token"}'\n`,
        );
        yield* fs.writeFileString(credentials, "");
        yield* fs.writeFileString(
          config,
          `[profile sandbox]\ncredential_process = /bin/sh "${helper}"\n${profileRegion ? `region = ${profileRegion}\n` : ""}`,
        );
        // distilled reads the real process environment. Isolate it in a child
        // instead of changing process.env in the concurrent test runner.
        const executable = yield* Effect.sync(() => process.execPath);
        const result = yield* exec(
          ChildProcess.make(
            executable,
            [path.join(import.meta.dirname, "fixtures", "aws-profile.ts")],
            {
              extendEnv: false,
              env: {
                HOME: dir,
                ALCHEMY_HOME: dir,
                AWS_CONFIG_FILE: config,
                AWS_SHARED_CREDENTIALS_FILE: credentials,
                AWS_PROFILE: "not-the-selected-profile",
                ...env,
              },
            },
          ),
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          accountId: "123456789012",
          region,
          credentialRegion: region,
          processCredentials: true,
          source: { type: "aws-profile", details: "sandbox" },
        });
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    );
  }

  for (const { name, env } of [
    { name: "over AWS_DEFAULT_REGION", env: { AWS_DEFAULT_REGION: "us-east-1" } },
    // AWS_REGION is the deploy region, but the role is assumed where the
    // profile lives, as the AWS SDK does: here, another partition.
    { name: "over AWS_REGION", env: { AWS_REGION: "us-east-1" } },
  ]) {
    it.effect(`uses the profile region while acquiring web identity credentials ${name}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-aws-profile-" });
        const config = path.join(dir, "config");
        const credentials = path.join(dir, "credentials");
        const token = path.join(dir, "token");
        yield* fs.writeFileString(token, "local-test-token");
        yield* fs.writeFileString(credentials, "");
        yield* fs.writeFileString(
          config,
          `[profile sandbox]\nregion = cn-north-1\nrole_arn = arn:aws-cn:iam::123456789012:role/review\nweb_identity_token_file = ${token}\n`,
        );
        const executable = yield* Effect.sync(() => process.execPath);
        const result = yield* exec(
          ChildProcess.make(
            executable,
            [path.join(import.meta.dirname, "fixtures", "aws-profile.ts")],
            {
              extendEnv: false,
              env: {
                HOME: dir,
                ALCHEMY_HOME: dir,
                AWS_CONFIG_FILE: config,
                AWS_SHARED_CREDENTIALS_FILE: credentials,
                ...env,
                AWS_PROFILE_TEST_ACTION: "refresh",
              },
            },
          ),
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          hostname: "sts.cn-north-1.amazonaws.com.cn",
        });
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    );
  }
});

/**
 * `profile edit --method aws-profile` reads the profile's kind and stores
 * the method that serves it, so SSO and `aws login` profiles keep their
 * login, refresh and logout flows.
 */
describe(
  "aws-profile detects the profile kind",
  { tags: ["unit", "provider:aws", "local"] },
  () => {
    const configure = (
      config: string,
      { credentials = "", env = {} }: { credentials?: string; env?: Record<string, string> } = {},
    ) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-aws-profile-" });
        const helper = path.join(dir, "credentials.sh");
        yield* fs.writeFileString(
          helper,
          `printf '%s' '{"Version":1,"AccessKeyId":"process-key","SecretAccessKey":"process-secret"}'\n`,
        );
        yield* fs.writeFileString(path.join(dir, "credentials"), credentials);
        yield* fs.writeFileString(path.join(dir, "config"), config.replace("$HELPER", helper));
        const executable = yield* Effect.sync(() => process.execPath);
        const result = yield* exec(
          ChildProcess.make(
            executable,
            [path.join(import.meta.dirname, "fixtures", "aws-profile.ts")],
            {
              extendEnv: false,
              env: {
                HOME: dir,
                ALCHEMY_HOME: dir,
                AWS_CONFIG_FILE: path.join(dir, "config"),
                AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "credentials"),
                AWS_PROFILE_TEST_ACTION: "configure",
                ...env,
              },
            },
          ),
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout) as Record<string, unknown>;
      }).pipe(Effect.scoped, Effect.provide(PlatformServices));

    it.effect("stores an SSO profile as sso", () =>
      Effect.gen(function* () {
        expect(
          yield* configure(
            [
              "[profile sandbox]",
              "sso_session = corp",
              "sso_account_id = 123456789012",
              "sso_role_name = Admin",
              "region = us-west-2",
              "[sso-session corp]",
              "sso_start_url = https://corp.awsapps.com/start",
              "sso_region = us-east-1",
              "",
            ].join("\n"),
          ),
        ).toEqual({ method: "sso", ssoProfile: "sandbox" });
      }),
    );

    it.effect("keeps an SSO profile with a role_arn fromIni ignores as sso", () =>
      Effect.gen(function* () {
        // `role_arn` without a source isn't an assumed role to fromIni, which
        // falls through to SSO, so the stored method does too.
        expect(
          yield* configure(
            [
              "[profile sandbox]",
              "sso_session = corp",
              "sso_account_id = 123456789012",
              "sso_role_name = Admin",
              "role_arn = arn:aws:iam::222222222222:role/deploy",
              "region = us-west-2",
              "[sso-session corp]",
              "sso_start_url = https://corp.awsapps.com/start",
              "sso_region = us-east-1",
              "",
            ].join("\n"),
          ),
        ).toEqual({ method: "sso", ssoProfile: "sandbox" });
      }),
    );

    it.effect("stores an aws login profile as console-login", () =>
      Effect.gen(function* () {
        expect(
          yield* configure(
            "[profile sandbox]\nlogin_session = arn:aws:iam::123456789012:user/me\nregion = us-west-2\n",
          ),
        ).toEqual({ method: "console-login", loginProfile: "sandbox" });
      }),
    );

    it.effect("verifies any other profile through STS as aws-profile", () =>
      Effect.gen(function* () {
        // The fixture's HTTP client reports the STS request, then interrupts it.
        expect(
          yield* configure(
            '[profile sandbox]\ncredential_process = /bin/sh "$HELPER"\nregion = us-west-2\n',
          ),
        ).toEqual({ hostname: "sts.us-west-2.amazonaws.com" });
      }),
    );

    it.effect("reports why a profile's credentials failed", () =>
      Effect.gen(function* () {
        const { message } = yield* configure(
          "[profile sandbox]\ncredential_process = /bin/sh -c 'exit 3'\nregion = us-west-2\n",
        );
        expect(message).toContain("AWS profile 'sandbox' did not resolve credentials");
        // distilled's own message is generic; the failing command is the reason.
        expect(message).toContain("Command failed: /bin/sh -c 'exit 3'");
      }),
    );

    it.effect("verifies through STS in AWS_REGION when it is set", () =>
      Effect.gen(function* () {
        expect(
          yield* configure(
            '[profile sandbox]\ncredential_process = /bin/sh "$HELPER"\nregion = us-west-2\n',
            { env: { AWS_REGION: "eu-central-1" } },
          ),
        ).toEqual({ hostname: "sts.eu-central-1.amazonaws.com" });
      }),
    );

    // fromIni resolves an assumed role or static keys before SSO, so the
    // stored method must too, or Alchemy would sign in as a different identity.
    for (const { name, config, credentials } of [
      {
        name: "an SSO profile that assumes a role",
        config: [
          "[profile sandbox]",
          "sso_session = corp",
          "sso_account_id = 111111111111",
          "sso_role_name = Admin",
          "role_arn = arn:aws:iam::222222222222:role/deploy",
          "source_profile = base",
          "region = us-west-2",
          "[sso-session corp]",
          "sso_start_url = https://corp.awsapps.com/start",
          "sso_region = us-east-1",
          "",
        ].join("\n"),
        credentials: "[base]\naws_access_key_id = AKIDEXAMPLE\naws_secret_access_key = secret\n",
      },
      {
        name: "an SSO profile with keys in ~/.aws/credentials",
        config:
          "[profile sandbox]\nsso_session = corp\nregion = us-west-2\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = us-east-1\n",
        credentials: "[sandbox]\naws_access_key_id = AKIDEXAMPLE\naws_secret_access_key = secret\n",
      },
    ]) {
      it.effect(`stores ${name} as aws-profile`, () =>
        Effect.gen(function* () {
          // The fixture's HTTP client reports the STS request, then interrupts it.
          expect(yield* configure(config, { credentials })).toEqual({
            hostname: "sts.us-west-2.amazonaws.com",
          });
        }),
      );
    }

    for (const { name, config } of [
      { name: "a profile that does not exist", config: "[profile other]\nregion = us-west-2\n" },
      { name: "a profile with only a region", config: "[profile sandbox]\nregion = us-west-2\n" },
    ]) {
      it.effect(`asks to sign in ${name}`, () =>
        Effect.gen(function* () {
          const { error } = yield* configure(config);
          expect(error).toContain("AWS profile 'sandbox' has no credentials");
          expect(error).toContain("aws login --profile sandbox");
        }),
      );
    }
  },
);

describe("parseAwsSsoLoginOutput", { tags: ["unit", "provider:aws", "local"] }, () => {
  it("reads browser authorization JSON", () => {
    expect(
      parseAwsSsoLoginOutput(
        JSON.stringify({ authorizationUrl: "https://oidc.example.com/authorize?state=abc" }),
      ),
    ).toEqual({ url: "https://oidc.example.com/authorize?state=abc", code: undefined });
  });

  it("reads the aws login browser prompt", () => {
    expect(
      parseAwsSsoLoginOutput(`Attempting to open your default browser. If the browser does not open, open the following URL.

https://us-east-1.signin.aws.amazon.com/v1/authorize?client_id=abc

`),
    ).toEqual({
      url: "https://us-east-1.signin.aws.amazon.com/v1/authorize?client_id=abc",
      code: undefined,
    });
  });

  it("reads the text AWS emits despite --output json", () => {
    expect(
      parseAwsSsoLoginOutput(`Browser will not be automatically opened.
Please visit the following URL:

https://example.awsapps.com/start/#/device

Then enter the code:

CRKF-LVXR`),
    ).toEqual({ url: "https://example.awsapps.com/start/#/device", code: "CRKF-LVXR" });
  });
});

describe("applyEnvRegionOverride", { tags: ["unit", "provider:aws", "local"] }, () => {
  it.effect("AWS_REGION overrides the profile region", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-east-2");
      expect(creds.accountId).toBe("123456789012");
    }).pipe(withEnv({ AWS_REGION: "us-east-2" })),
  );

  // AWS_DEFAULT_REGION is a default, not an override — the profile's region
  // is explicit configuration and must win over it.
  it.effect("AWS_DEFAULT_REGION does NOT override the profile region", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-west-2");
    }).pipe(withEnv({ AWS_DEFAULT_REGION: "eu-west-1" })),
  );

  it.effect("falls back to the profile region when no env is set", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-west-2");
    }).pipe(withEnv({})),
  );

  it.effect(
    "process environment overrides the default dotenv region",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-config-provider-" });
          yield* fs.writeFileString(path.join(tempDir, ".env"), "AWS_REGION=ap-south-1\n");

          const originalCwd = process.cwd();
          const originalRegion = process.env.AWS_REGION;
          yield* Effect.gen(function* () {
            yield* Effect.sync(() => {
              process.chdir(tempDir);
              process.env.AWS_REGION = "us-east-1";
            });

            const configProvider = yield* loadConfigProvider(Option.none());
            const creds = yield* applyEnvRegionOverride({
              accountId: "654654387918",
              region: "us-west-2",
            }).pipe(Effect.provide(ConfigProvider.layer(configProvider)));
            expect(creds.region).toBe("us-east-1");
            expect(creds.accountId).toBe("654654387918");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                process.chdir(originalCwd);
                if (originalRegion === undefined) {
                  delete process.env.AWS_REGION;
                } else {
                  process.env.AWS_REGION = originalRegion;
                }
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );
});
