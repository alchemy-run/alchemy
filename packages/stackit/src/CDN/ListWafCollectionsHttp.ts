import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListWafCollections } from "./ListWafCollections.ts";

/**
 * HTTP implementation of {@link ListWafCollections}.
 *
 * @layer
 * @provides Stackit.CDN.ListWafCollections
 */
export const ListWafCollectionsHttp = Layer.effect(
  ListWafCollections,
  makeScopeHttpBinding({
    tag: "Stackit.CDN.ListWafCollections",
    access: CDN_READ_ACCESS,
    operation: cdn.listWafCollections,
  }),
);
