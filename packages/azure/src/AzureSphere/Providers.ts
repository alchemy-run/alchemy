import * as Layer from "effect/Layer";
import { Catalog, CatalogProvider } from "./Catalog.ts";
import { DeviceGroup, DeviceGroupProvider } from "./DeviceGroup.ts";
import { Product, ProductProvider } from "./Product.ts";

export const resources = [Catalog, DeviceGroup, Product];
export const layers = () =>
  Layer.mergeAll(CatalogProvider(), DeviceGroupProvider(), ProductProvider());
