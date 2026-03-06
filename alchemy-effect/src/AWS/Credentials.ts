import {
  Credentials,
  fromAwsCredentialIdentity,
  loadSSOCredentials,
} from "distilled-aws/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Profile } from "./Profile.ts";

import { StageConfig } from "./StageConfig.ts";

export const fromStageConfig = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const config = yield* StageConfig;
      if (config.profile) {
        return yield* loadSSOCredentials(config.profile);
      } else if (config.credentials) {
        return fromAwsCredentialIdentity(config.credentials);
      }
      return yield* Effect.die("No AWS credentials found in stage config");
    }),
  );

export const fromSSO = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profileName = Option.getOrElse(
        yield* Effect.serviceOption(Profile),
        () => "default",
      );
      return yield* loadSSOCredentials(profileName);
    }),
  );
