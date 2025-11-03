import {
  fromContainerMetadata as _fromContainerMetadata,
  fromEnv as _fromEnv,
  fromHttp as _fromHttp,
  fromIni as _fromIni,
  fromInstanceMetadata as _fromInstanceMetadata,
  fromNodeProviderChain as _fromNodeProviderChain,
  fromProcess as _fromProcess,
  fromTokenFile as _fromTokenFile,
  fromWebToken as _fromWebToken,
} from "@aws-sdk/credential-providers";
import { FileSystem, HttpClient } from "@effect/platform";
import * as ini from "@smithy/shared-ini-file-loader";
import {
  type AwsCredentialIdentity,
  type AwsCredentialIdentityProvider,
} from "@smithy/types";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { parseIni, parseSSOSessionData } from "./parse-ini.ts";
import { AwsProfile } from "./profile.ts";

export class Credentials extends Context.Tag("AWS::Credentials")<
  Credentials,
  {
    accessKeyId: Redacted.Redacted<string>;
    secretAccessKey: Redacted.Redacted<string>;
    sessionToken: Redacted.Redacted<string> | undefined;
    expiration?: number;
  }
>() {}

export const fromAwsCredentialIdentity = (identity: AwsCredentialIdentity) =>
  Credentials.of({
    accessKeyId: Redacted.make(identity.accessKeyId),
    secretAccessKey: Redacted.make(identity.secretAccessKey),
    sessionToken: identity.sessionToken
      ? Redacted.make(identity.sessionToken)
      : undefined,
    expiration: identity.expiration?.getTime(),
  });

const createLayer = (provider: (config: {}) => AwsCredentialIdentityProvider) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      return fromAwsCredentialIdentity(
        yield* Effect.promise(() => provider({})()),
      );
    }),
  );

export const fromCredentials = (credentials: AwsCredentialIdentity) =>
  Layer.succeed(Credentials, fromAwsCredentialIdentity(credentials));

export const fromEnv = () => createLayer(_fromEnv);

export const fromChain = () => createLayer(() => _fromNodeProviderChain());

// export const fromSSO = () => createLayer(_fromSSO);

export const fromIni = () => createLayer(_fromIni);

export const fromContainerMetadata = () => createLayer(_fromContainerMetadata);

export const fromHttp = () => createLayer(_fromHttp);

export const fromInstanceMetadata = (
  ...parameters: Parameters<typeof _fromInstanceMetadata>
) => createLayer(() => _fromInstanceMetadata(...parameters));

export const fromProcess = () => createLayer(_fromProcess);

export const fromTokenFile = () => createLayer(_fromTokenFile);

export const fromWebToken = (...parameters: Parameters<typeof _fromWebToken>) =>
  createLayer(() => _fromWebToken(...parameters));

export const ssoRegion = (region: string) => Layer.succeed(SsoRegion, region);

/**
 * The time window (5 mins) that SDK will treat the SSO token expires in before the defined expiration date in token.
 * This is needed because server side may have invalidated the token before the defined expiration date.
 */
const EXPIRE_WINDOW_MS = 5 * 60 * 1000;

const REFRESH_MESSAGE = `To refresh this SSO session run 'aws sso login' with the corresponding profile.`;

export class SsoRegion extends Context.Tag("AWS::SsoRegion")<
  SsoRegion,
  string
>() {}
export class SsoStartUrl extends Context.Tag("AWS::SsoStartUrl")<
  SsoStartUrl,
  string
>() {}

export class ProfileNotFound extends Data.TaggedError(
  "Alchemy::AWS::ProfileNotFound",
)<{
  message: string;
  profile: string;
}> {}

export class ConflictingSSORegion extends Data.TaggedError(
  "Alchemy::AWS::ConflictingSSORegion",
)<{
  message: string;
  ssoRegion: string;
  profile: string;
}> {}

export class ConflictingSSOStartUrl extends Data.TaggedError(
  "Alchemy::AWS::ConflictingSSOStartUrl",
)<{
  message: string;
  ssoStartUrl: string;
  profile: string;
}> {}

export class InvalidSSOProfile extends Data.TaggedError(
  "Alchemy::AWS::InvalidSSOProfile",
)<{
  message: string;
  profile: string;
  missingFields: string[];
}> {}

export class InvalidSSOToken extends Data.TaggedError(
  "Alchemy::AWS::InvalidSSOToken",
)<{
  message: string;
  sso_session: string;
}> {}

export class ExpiredSSOToken extends Data.TaggedError(
  "Alchemy::AWS::ExpiredSSOToken",
)<{
  message: string;
  profile: string;
}> {}

export interface AwsProfileConfig {
  sso_session?: string;
  sso_account_id?: string;
  sso_role_name?: string;
  region?: string;
  output?: string;
  sso_start_url?: string;
  sso_region?: string;
}
export interface SsoProfileConfig extends AwsProfileConfig {
  sso_start_url: string;
  sso_region: string;
  sso_account_id: string;
  sso_role_name: string;
}

export const fromSSO = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem.FileSystem;
      const profileName = Option.getOrElse(
        yield* Effect.serviceOption(AwsProfile),
        () => "default",
      );

      const profiles: {
        [profileName: string]: AwsProfileConfig;
      } = yield* Effect.promise(() =>
        ini.parseKnownFiles({ profile: profileName }),
      );

      const profile = profiles[profileName];

      if (!profile) {
        yield* Effect.fail(
          new ProfileNotFound({
            message: `Profile ${profileName} not found`,
            profile: profileName,
          }),
        );
      }

      const awsDir = path.join(ini.getHomeDir(), ".aws");
      const configPath = path.join(awsDir, "config");
      const cachePath = path.join(awsDir, "sso", "cache");

      if (profile.sso_session) {
        const ssoRegion = Option.getOrUndefined(
          yield* Effect.serviceOption(SsoRegion),
        );
        const ssoStartUrl = Option.getOrElse(
          yield* Effect.serviceOption(SsoStartUrl),
          () => profile.sso_start_url,
        );

        const ssoSessions = yield* fs.readFileString(configPath).pipe(
          Effect.flatMap((config) =>
            Effect.promise(async () => parseIni(config)),
          ),
          Effect.map(parseSSOSessionData),
        );
        const session = ssoSessions[profile.sso_session];
        if (ssoRegion && ssoRegion !== session.sso_region) {
          yield* Effect.fail(
            new ConflictingSSORegion({
              message: `Conflicting SSO region`,
              ssoRegion: ssoRegion,
              profile: profile.sso_session,
            }),
          );
        }
        if (ssoStartUrl && ssoStartUrl !== session.sso_start_url) {
          yield* Effect.fail(
            new ConflictingSSOStartUrl({
              message: `Conflicting SSO start url`,
              ssoStartUrl: ssoStartUrl,
              profile: profile.sso_session,
            }),
          );
        }
        profile.sso_region = session.sso_region;
        profile.sso_start_url = session.sso_start_url;

        const ssoFields = [
          "sso_start_url",
          "sso_account_id",
          "sso_region",
          "sso_role_name",
        ] as const satisfies (keyof SsoProfileConfig)[];
        const missingFields = ssoFields.filter((field) => !profile[field]);
        if (missingFields.length > 0) {
          yield* Effect.fail(
            new InvalidSSOProfile({
              profile: profileName,
              missingFields,
              message:
                `Profile is configured with invalid SSO credentials. Required parameters "sso_account_id", ` +
                `"sso_region", "sso_role_name", "sso_start_url". Got ${Object.keys(
                  profile,
                ).join(
                  ", ",
                )}\nReference: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html`,
            }),
          );
        }

        const hasher = createHash("sha1");
        const cacheName = hasher.update(profile.sso_session).digest("hex");
        const ssoTokenFilepath = path.join(cachePath, `${cacheName}.json`);
        const cachedCredsFilePath = path.join(
          cachePath,
          `${cacheName}.credentials.json`,
        );

        const cachedCreds = yield* fs.readFileString(cachedCredsFilePath).pipe(
          Effect.map((text) => JSON.parse(text)),
          Effect.catchAll(() => Effect.void),
        );

        const isExpired = (expiry: number | string | undefined) => {
          return (
            expiry === undefined ||
            new Date(expiry).getTime() - Date.now() <= EXPIRE_WINDOW_MS
          );
        };

        if (cachedCreds && !isExpired(cachedCreds.expiry)) {
          return Credentials.of({
            accessKeyId: Redacted.make(cachedCreds.accessKeyId),
            secretAccessKey: Redacted.make(cachedCreds.secretAccessKey),
            sessionToken: cachedCreds.sessionToken
              ? Redacted.make(cachedCreds.sessionToken)
              : undefined,
            expiration: cachedCreds.expiry,
          });
        }

        const ssoToken = yield* fs.readFileString(ssoTokenFilepath).pipe(
          Effect.map((text) => JSON.parse(text) as SSOToken),
          Effect.catchAll(() =>
            Effect.fail(
              new InvalidSSOToken({
                message: `The SSO session token associated with profile=${profileName} was not found or is invalid. ${REFRESH_MESSAGE}`,
                sso_session: profile.sso_session!,
              }),
            ),
          ),
        );

        if (isExpired(ssoToken.expiresAt)) {
          yield* Console.log(
            `The SSO session token associated with profile=${profileName} was not found or is invalid. ${REFRESH_MESSAGE}`,
          );
          yield* Effect.fail(
            new ExpiredSSOToken({
              message: `The SSO session token associated with profile=${profileName} was not found or is invalid. ${REFRESH_MESSAGE}`,
              profile: profileName,
            }),
          );
        }

        const response = yield* client.get(
          `https://portal.sso.${profile.sso_region}.amazonaws.com/federation/credentials?account_id=${profile.sso_account_id}&role_name=${profile.sso_role_name}`,
          {
            headers: {
              "User-Agent": "alchemy.run",
              "Content-Type": "application/json",
              "x-amz-sso_bearer_token": ssoToken.accessToken,
            },
          },
        );

        const credentials = (
          (yield* response.json) as {
            roleCredentials: {
              accessKeyId: string;
              secretAccessKey: string;
              sessionToken: string;
              expiration: number;
            };
          }
        ).roleCredentials;

        yield* fs.writeFileString(
          cachedCredsFilePath,
          JSON.stringify({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
            expiry: credentials.expiration,
          }),
        );

        return Credentials.of({
          accessKeyId: Redacted.make(credentials.accessKeyId),
          secretAccessKey: Redacted.make(credentials.secretAccessKey),
          sessionToken: Redacted.make(credentials.sessionToken),
          expiration: credentials.expiration,
        });
      }

      return yield* Effect.fail(
        new ProfileNotFound({
          message: `Profile ${profileName} not found`,
          profile: profileName,
        }),
      );
    }),
  );

/**
 * Cached SSO token retrieved from SSO login flow.
 * @public
 */
export interface SSOToken {
  /**
   * A base64 encoded string returned by the sso-oidc service.
   */
  accessToken: string;

  /**
   * The expiration time of the accessToken as an RFC 3339 formatted timestamp.
   */
  expiresAt: string;

  /**
   * The token used to obtain an access token in the event that the accessToken is invalid or expired.
   */
  refreshToken?: string;

  /**
   * The unique identifier string for each client. The client ID generated when performing the registration
   * portion of the OIDC authorization flow. This is used to refresh the accessToken.
   */
  clientId?: string;

  /**
   * A secret string generated when performing the registration portion of the OIDC authorization flow.
   * This is used to refresh the accessToken.
   */
  clientSecret?: string;

  /**
   * The expiration time of the client registration (clientId and clientSecret) as an RFC 3339 formatted timestamp.
   */
  registrationExpiresAt?: string;

  /**
   * The configured sso_region for the profile that credentials are being resolved for.
   */
  region?: string;

  /**
   * The configured sso_start_url for the profile that credentials are being resolved for.
   */
  startUrl?: string;
}
