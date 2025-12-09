import * as Context from "effect/Context";

export class Profile extends Context.Tag("AWS::Profile")<Profile, string>() {}
