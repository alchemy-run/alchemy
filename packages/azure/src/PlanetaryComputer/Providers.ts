import * as Layer from "effect/Layer";
import { GeoCatalog, GeoCatalogProvider } from "./GeoCatalog.ts";

export const resources = [GeoCatalog];
export const layers = () => Layer.mergeAll(GeoCatalogProvider());
