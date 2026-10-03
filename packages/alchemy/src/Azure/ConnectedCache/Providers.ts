import * as Layer from "effect/Layer";
import {
  EnterpriseMccCacheNode,
  EnterpriseMccCacheNodeProvider,
} from "./EnterpriseMccCacheNode.ts";
import {
  EnterpriseMccCustomer,
  EnterpriseMccCustomerProvider,
} from "./EnterpriseMccCustomer.ts";

export const resources = [EnterpriseMccCustomer, EnterpriseMccCacheNode];
export const layers = () =>
  Layer.mergeAll(
    EnterpriseMccCustomerProvider(),
    EnterpriseMccCacheNodeProvider(),
  );
