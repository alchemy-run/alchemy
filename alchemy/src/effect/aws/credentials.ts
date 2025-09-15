import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export class Credentials extends Context.Tag("AWS::Credentials")<
  Credentials,
  {
    accessKeyId: Redacted.Redacted<string>;
    secretAccessKey: Redacted.Redacted<string>;
    sessionToken: Redacted.Redacted<string | undefined>;
  }
>() {}

export const fromEnv = Layer.succeed(
  Credentials,
  Credentials.of({
    accessKeyId: Redacted.make(process.env.AWS_ACCESS_KEY_ID!),
    secretAccessKey: Redacted.make(process.env.AWS_SECRET_ACCESS_KEY!),
    sessionToken: Redacted.make(process.env.AWS_SESSION_TOKEN),
  }),
);
