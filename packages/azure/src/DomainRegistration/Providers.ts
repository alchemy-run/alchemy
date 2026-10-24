import * as Layer from "effect/Layer";
import { Domain, DomainProvider } from "./Domain.ts";

export const resources = [Domain];
export const layers = () => Layer.mergeAll(DomainProvider());
