import * as ServiceMap from "effect/ServiceMap";

export class Profile extends ServiceMap.Service<Profile, string>()(
  "AWS::Profile",
) {}
