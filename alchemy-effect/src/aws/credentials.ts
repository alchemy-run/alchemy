import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { App } from "../app.ts";
import {
  Credentials,
  loadSSOCredentials,
  fromAwsCredentialIdentity,
} from "distilled-aws/Credentials";
import { Profile } from "./profile.ts";

export const fromStageConfig = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const app = yield* App;
      if (app.config.aws?.profile) {
        return yield* loadSSOCredentials(app.config.aws.profile);
      } else if (app.config.aws?.credentials) {
        return fromAwsCredentialIdentity(app.config.aws.credentials);
      }
      return yield* Effect.dieMessage(
        "No AWS credentials found in stage config",
      );
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
