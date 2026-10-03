import * as Layer from "effect/Layer";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import { Instance, InstanceProvider } from "./Instance.ts";
import {
  TimeSeriesDatabaseConnection,
  TimeSeriesDatabaseConnectionProvider,
} from "./TimeSeriesDatabaseConnection.ts";

export const resources = [Endpoint, Instance, TimeSeriesDatabaseConnection];
export const layers = () =>
  Layer.mergeAll(
    EndpointProvider(),
    InstanceProvider(),
    TimeSeriesDatabaseConnectionProvider(),
  );
