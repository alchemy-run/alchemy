import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { App } from "../app.ts";

export class Endpoint extends Context.Tag("AWS::Endpoint")<
  Endpoint,
  EndpointID | undefined
>() {}

export type EndpointID = string;

export const of = (endpoint: string) => Layer.succeed(Endpoint, endpoint);

export const fromStageConfig = () =>
  Layer.effect(
    Endpoint,
    Effect.gen(function* () {
      const app = yield* App;
      return app.config.aws?.endpoint;
    }),
  );
