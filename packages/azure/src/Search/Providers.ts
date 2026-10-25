import * as Layer from "effect/Layer";
import { SearchIndex, SearchIndexProvider } from "./SearchIndex.ts";
import { SearchService, SearchServiceProvider } from "./SearchService.ts";
import {
  SharedPrivateLinkResource,
  SharedPrivateLinkResourceProvider,
} from "./SharedPrivateLinkResource.ts";

export const resources = [SearchIndex, SearchService, SharedPrivateLinkResource];
export const layers = () =>
  Layer.mergeAll(
    SearchIndexProvider(),
    SearchServiceProvider(),
    SharedPrivateLinkResourceProvider(),
  );
