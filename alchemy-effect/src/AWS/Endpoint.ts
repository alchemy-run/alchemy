import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { StageConfig } from "./StageConfig.ts";

export class Endpoint extends ServiceMap.Service<
  Endpoint,
  EndpointID | undefined
>()("AWS::Endpoint") {}

export type EndpointID = string;

export const of = (endpoint: string) => Layer.succeed(Endpoint, endpoint);

export const fromStageConfig = () =>
  Layer.effect(
    Endpoint,
    StageConfig.asEffect().pipe(Effect.map((config) => config.endpoint)),
  );
