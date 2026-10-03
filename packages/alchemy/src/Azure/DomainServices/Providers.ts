import * as Layer from "effect/Layer";
import { DomainService, DomainServiceProvider } from "./DomainService.ts";
import { OuContainer, OuContainerProvider } from "./OuContainer.ts";

export const resources = [DomainService, OuContainer];
export const layers = () =>
  Layer.mergeAll(DomainServiceProvider(), OuContainerProvider());
