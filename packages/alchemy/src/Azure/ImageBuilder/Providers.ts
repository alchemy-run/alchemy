import * as Layer from "effect/Layer";
import { ImageTemplate, ImageTemplateProvider } from "./ImageTemplate.ts";
import { Trigger, TriggerProvider } from "./Trigger.ts";

export const resources = [ImageTemplate, Trigger];
export const layers = () =>
  Layer.mergeAll(ImageTemplateProvider(), TriggerProvider());
