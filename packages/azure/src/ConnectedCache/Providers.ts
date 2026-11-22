import * as Layer from "effect/Layer";
import {
  EnterpriseMccCacheNode,
  EnterpriseMccCacheNodeProvider,
} from "./EnterpriseMccCacheNode.ts";
import { EnterpriseMccCustomer, EnterpriseMccCustomerProvider } from "./EnterpriseMccCustomer.ts";
import { IspCacheNode, IspCacheNodeProvider } from "./IspCacheNode.ts";
import { IspCustomer, IspCustomerProvider } from "./IspCustomer.ts";

export const resources = [EnterpriseMccCustomer, EnterpriseMccCacheNode, IspCustomer, IspCacheNode];
export const layers = () =>
  Layer.mergeAll(
    EnterpriseMccCustomerProvider(),
    EnterpriseMccCacheNodeProvider(),
    IspCustomerProvider(),
    IspCacheNodeProvider(),
  );
