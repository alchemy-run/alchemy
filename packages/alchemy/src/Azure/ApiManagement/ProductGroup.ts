import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface ProductGroupProps {
  /** Resource group of the API Management service. Changing it replaces the association. */
  resourceGroup: string;
  /** API Management service that holds the product and group. Changing it replaces the association. */
  serviceName: string;
  /** Identifier of the product. Changing it replaces the association. */
  productName: string;
  /** Identifier of the {@link Group} given access to the product. Changing it replaces the association. */
  groupName: string;
}

export interface ProductGroup extends Resource<
  "Azure.ApiManagement.ProductGroup",
  ProductGroupProps,
  {
    /** ARM resource ID of the product/group association. */
    productGroupId: string;
    /** Identifier of the product. */
    productName: string;
    /** Identifier of the group. */
    groupName: string;
    /** API Management service that holds the product and group. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Makes an API Management product visible to a {@link Group}, so its
 * members can see and subscribe to the product in the developer portal.
 * The association has no settings; changing the product or group
 * replaces it. {@link ProductGroupLink} expresses the same relation as a
 * named link entity. Groups are not available on the Consumption tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-create-groups
 *
 * ### Granting Product Access
 * **Example:** Let partners see the premium product
 * ```typescript
 * yield* Azure.ApiManagement.ProductGroup("premium-partners", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   productName: premium.productName,
 *   groupName: partners.groupName,
 * });
 * ```
 *
 * @resource
 */
export const ProductGroup = Resource<ProductGroup>(
  "Azure.ApiManagement.ProductGroup",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  groupName: string;
  productName: string;
}

export const ProductGroupProvider = () =>
  Provider.succeed(ProductGroup, {
    stables: [
      "productGroupId",
      "groupName",
      "productName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ProductGroupProps,
      ProductGroup["Attributes"],
      Key,
      apim.GroupContract
    >({
      label: (key) =>
        `API Management group ${key.groupName} of product ${key.productName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          groupName: props.groupName,
          productName: props.productName,
        }),
      keyOfAttrs: (attrs) => attrs,
      // There is no GET for one association; the exact-name filter matches at
      // most one group, so the first page is authoritative.
      get: (subscriptionId, key) =>
        apim
          .ListProductGroupByProduct({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            productId: key.productName,
            _filter: `name eq '${key.groupName}'`,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find((group) => sameName(group.name, key.groupName)),
            ),
          ),
      put: (subscriptionId, key) =>
        apim.ProductGroupCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
          groupId: key.groupName,
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteProductGroup({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
          groupId: key.groupName,
        }),
      toAttrs: (subscriptionId, key) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        groupName: key.groupName,
        productName: key.productName,
        productGroupId: serviceEntityId(
          subscriptionId,
          key,
          `products/${key.productName}/groups/${key.groupName}`,
        ),
      }),
    }),
  });
