import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  defaultInvoiceMonth,
  desiredRepricingConfig,
  findCustomerRepricing,
  getCustomer,
  hasOwnershipMarker,
  jsonEqual,
  listAccountParents,
  listCustomerRepricingConfigs,
  listCustomers,
  normalizeDate,
  normalizeName,
  parentOf,
  replaceOnIdentity,
  toCustomerRepricingAttrs,
  toRepricingConfigName,
} from "./internal.ts";

export type CustomersCustomerRepricingConfigProps = {
  /**
   * Customer that receives this repricing config. Full name
   * `accounts/{account}/customers/{customer}`. Immutable — changing it
   * replaces the config.
   */
  parent: string;
  /**
   * Config id (last segment of the resource name). Server-assigned on
   * create. Immutable — changing it replaces the config.
   */
  configId?: string;
  /**
   * Year/month when the adjustment activates. Day must be `0`. You can
   * only create or update configs for a future month. Immutable —
   * changing it replaces the config.
   */
  effectiveInvoiceMonth?: cloudchannel.GoogleTypeDate;
  /**
   * Rebilling basis used for the bill.
   * @default "COST_AT_LIST"
   */
  rebillingBasis?:
    | cloudchannel.GoogleCloudChannelV1RepricingConfigRebillingBasisEnum
    | (string & {});
  /**
   * Markup or markdown percentage (`"1.00"` is +1%, `"-1.00"` is -1%,
   * `"0.00"` is pass-through). Ignored when `adjustment` is set.
   * @default "0.00"
   */
  adjustmentPercentage?: string;
  /**
   * Full adjustment. Defaults to a percentage adjustment of
   * `adjustmentPercentage`.
   */
  adjustment?: cloudchannel.GoogleCloudChannelV1RepricingAdjustment;
  /**
   * Entitlement this config applies to
   * (`accounts/{account}/customers/{customer}/entitlements/{entitlement}`).
   */
  entitlement?: string;
  /**
   * Entitlement granularity. Takes precedence over `entitlement`.
   */
  entitlementGranularity?: cloudchannel.GoogleCloudChannelV1RepricingConfigEntitlementGranularity;
  /**
   * Conditional overrides applied before the default adjustment.
   */
  conditionalOverrides?: cloudchannel.GoogleCloudChannelV1ConditionalOverrideList;
};

export type CustomersCustomerRepricingConfig = Resource<
  "GCP.Cloudchannel.CustomersCustomerRepricingConfig",
  CustomersCustomerRepricingConfigProps,
  {
    /** Resource name `accounts/{account}/customers/{customer}/customerRepricingConfigs/{id}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Parent customer resource name. */
    parent: string;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Repricing configuration. */
    repricingConfig:
      | cloudchannel.GoogleCloudChannelV1RepricingConfig
      | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Channel customer repricing config.
 *
 * Repricing configs have no labels field. `list` / nuke returns configs
 * whose parent customer carries an Alchemy ownership marker. Parent
 * customer and effective invoice month are identity — changing either
 * replaces the config. Adjustment, rebilling basis, entitlement, and
 * overrides update in place for a future month.
 *
 * Creating configs requires Cloud Channel reseller access and a
 * provisioned entitlement.
 *
 * ### Creating a Customer Repricing Config
 * **Example:** Pass-through for a future month
 * ```typescript
 * const config = yield* GCP.Cloudchannel.CustomersCustomerRepricingConfig(
 *   "AcmeBill",
 *   {
 *     parent: customer.name,
 *     effectiveInvoiceMonth: { year: 2099, month: 1, day: 0 },
 *     entitlement: `${customer.name}/entitlements/ent-1`,
 *   },
 * );
 * ```
 *
 * **Example:** One percent markup
 * ```typescript
 * const config = yield* GCP.Cloudchannel.CustomersCustomerRepricingConfig(
 *   "AcmeBill",
 *   {
 *     parent: customer.name,
 *     effectiveInvoiceMonth: { year: 2099, month: 1, day: 0 },
 *     adjustmentPercentage: "1.00",
 *     entitlement: `${customer.name}/entitlements/ent-1`,
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Cloudchannel
 */
export const CustomersCustomerRepricingConfig =
  Resource<CustomersCustomerRepricingConfig>(
    "GCP.Cloudchannel.CustomersCustomerRepricingConfig",
  );

export class CustomersCustomerRepricingConfigNotResolved extends Data.TaggedError(
  "GCP.Cloudchannel.CustomersCustomerRepricingConfigNotResolved",
)<{
  name: string;
}> {}

const monthOf = (
  news: CustomersCustomerRepricingConfigProps,
  outputMonth?: cloudchannel.GoogleTypeDate,
) =>
  Effect.gen(function* () {
    return (
      normalizeDate(news.effectiveInvoiceMonth) ??
      normalizeDate(outputMonth) ??
      (yield* defaultInvoiceMonth())
    );
  });

export const CustomersCustomerRepricingConfigProvider = () =>
  Provider.succeed(CustomersCustomerRepricingConfig, {
    stables: ["name", "configId", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMonth = normalizeDate(
        olds?.effectiveInvoiceMonth ??
          output?.repricingConfig?.effectiveInvoiceMonth,
      );
      const nextMonth = normalizeDate(news.effectiveInvoiceMonth);
      return replaceOnIdentity({
        previousId: olds?.configId ?? output?.configId,
        nextId: news.configId,
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        extra:
          previousMonth !== undefined &&
          nextMonth !== undefined &&
          !jsonEqual(previousMonth, nextMonth),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const parent = normalizeName(olds?.parent ?? output?.parent ?? "");
      const name = toRepricingConfigName(
        parent,
        olds?.configId ?? output?.configId ?? output?.name,
        "customerRepricingConfigs",
      );
      const existing = yield* findCustomerRepricing(
        parent,
        output?.name ?? name,
        olds?.effectiveInvoiceMonth ??
          output?.repricingConfig?.effectiveInvoiceMonth,
      );
      if (existing === undefined) return undefined;
      const attrs = toCustomerRepricingAttrs(existing);
      const customer = yield* getCustomer(attrs.parent);
      return hasOwnershipMarker(customer?.orgDisplayName)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const accounts = listAccountParents(env.project);
        const customers = (yield* Effect.forEach(
          accounts,
          (account) => listCustomers(account),
          { concurrency: 4 },
        ))
          .flat()
          .filter((customer) => hasOwnershipMarker(customer.orgDisplayName));
        const wildcardParents = accounts.map(
          (account) => `${account}/customers/-`,
        );
        const parents = [
          ...wildcardParents,
          ...customers
            .map((customer) => customer.name)
            .filter((name): name is string => !!name),
        ];
        const pages = yield* Effect.forEach(
          parents,
          (parent) => listCustomerRepricingConfigs(parent),
          { concurrency: 4 },
        );
        const ownedParents = new Set(
          customers
            .map((customer) => customer.name)
            .filter((name): name is string => !!name),
        );
        const seen = new Set<string>();
        const attrs = [];
        for (const config of pages.flat()) {
          const name = config.name ?? "";
          if (name.length === 0 || seen.has(name)) continue;
          const parent = parentOf(name);
          if (!ownedParents.has(parent)) continue;
          seen.add(name);
          attrs.push(toCustomerRepricingAttrs(config));
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const parent = normalizeName(news.parent);
      const month = yield* monthOf(
        news,
        output?.repricingConfig?.effectiveInvoiceMonth,
      );
      const repricingConfig = desiredRepricingConfig({
        effectiveInvoiceMonth: month,
        rebillingBasis: news.rebillingBasis,
        adjustmentPercentage: news.adjustmentPercentage,
        adjustment: news.adjustment,
        entitlementGranularity:
          news.entitlementGranularity ??
          (news.entitlement
            ? { entitlement: news.entitlement }
            : output?.repricingConfig?.entitlementGranularity),
        conditionalOverrides: news.conditionalOverrides,
      });
      const name = toRepricingConfigName(
        parent,
        news.configId ?? output?.configId ?? output?.name,
        "customerRepricingConfigs",
      );

      let current = yield* findCustomerRepricing(
        parent,
        output?.name ?? name,
        month,
      );

      if (current === undefined) {
        const created = yield* cloudchannel
          .createAccountsCustomersCustomerRepricingConfigs({
            parent,
            body: { repricingConfig },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findCustomerRepricing(parent, name, month),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersCustomerRepricingConfigNotResolved({
          name: name || `${parent}/customerRepricingConfigs`,
        });
      }

      const currentName = current.name ?? name;
      const observed = current.repricingConfig;
      const changed =
        !jsonEqual(
          normalizeDate(observed?.effectiveInvoiceMonth),
          normalizeDate(repricingConfig.effectiveInvoiceMonth),
        ) ||
        (observed?.rebillingBasis ?? "") !==
          (repricingConfig.rebillingBasis ?? "") ||
        !jsonEqual(observed?.adjustment, repricingConfig.adjustment) ||
        !jsonEqual(
          observed?.entitlementGranularity,
          repricingConfig.entitlementGranularity,
        ) ||
        !jsonEqual(
          observed?.conditionalOverrides,
          repricingConfig.conditionalOverrides,
        );

      if (changed && currentName.length > 0) {
        current =
          yield* cloudchannel.patchAccountsCustomersCustomerRepricingConfigs({
            name: currentName,
            body: { name: currentName, repricingConfig },
          });
      }

      return toCustomerRepricingAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      yield* cloudchannel
        .deleteAccountsCustomersCustomerRepricingConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
