import * as Layer from "effect/Layer";
import { SearchService, SearchServiceProvider } from "./SearchService.ts";
import {
  SharedPrivateLinkResource,
  SharedPrivateLinkResourceProvider,
} from "./SharedPrivateLinkResource.ts";

export const resources = [SearchService, SharedPrivateLinkResource];
export const layers = () =>
  Layer.mergeAll(SearchServiceProvider(), SharedPrivateLinkResourceProvider());
