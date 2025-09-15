import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class Region extends Context.Tag("AWS::Region")<Region, string>() {}

export const fromEnv = Layer.succeed(Region, process.env.AWS_REGION!);
