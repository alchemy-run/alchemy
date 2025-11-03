import * as Context from "effect/Context";

export class AwsProfile extends Context.Tag("AWS::Profile")<
  AwsProfile,
  string
>() {}
