import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import {
  ApplicationDefinition,
  ApplicationDefinitionProvider,
} from "./ApplicationDefinition.ts";

export const resources = [Application, ApplicationDefinition];
export const layers = () =>
  Layer.mergeAll(ApplicationProvider(), ApplicationDefinitionProvider());
