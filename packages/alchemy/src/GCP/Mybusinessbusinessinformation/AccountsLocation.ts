import * as mybiz from "@distilled.cloud/gcp/mybusinessbusinessinformation_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountParent,
  createInternalLabels,
  hasOwnershipMarker,
  lastSegment,
  mergeLabels,
  ownedByAlchemy,
  ownedTitle,
  READ_MASK,
  userLabels,
} from "./internal.ts";

export type PostalAddress = {
  regionCode?: string;
  languageCode?: string;
  postalCode?: string;
  administrativeArea?: string;
  locality?: string;
  addressLines?: string[];
};

export type AccountsLocationProps = {
  /**
   * Parent account `accounts/{account}`. Defaults to `accounts/-`.
   * Immutable — changing it replaces the location.
   */
  parent?: string;
  /**
   * Real-world business name. Required by the API.
   */
  title?: string;
  /**
   * Storefront postal address. Required for most location types.
   */
  storefrontAddress?: PostalAddress;
  /**
   * Store code unique within the account.
   */
  storeCode?: string;
  /**
   * Language of the location (`en`, `en-US`, …).
   * @default "en"
   */
  languageCode?: string;
  /**
   * Website URI.
   */
  websiteUri?: string;
  /**
   * User labels. My Business labels are a string list (not a map);
   * Alchemy ownership entries `alchemy-stack=…` are merged in and
   * stripped from attributes.
   */
  labels?: string[];
};

export type AccountsLocation = Resource<
  "GCP.Mybusinessbusinessinformation.AccountsLocation",
  AccountsLocationProps,
  {
    /** Resource name `locations/{locationId}`. */
    name: string;
    /** Location id (last path segment). */
    locationId: string;
    /** Parent account. */
    parent: string;
    /** Business title. */
    title: string | undefined;
    /** Store code. */
    storeCode: string | undefined;
    /** Language code. */
    languageCode: string | undefined;
    /** Storefront address. */
    storefrontAddress: PostalAddress | undefined;
    /** Website URI. */
    websiteUri: string | undefined;
    /** User labels (Alchemy ownership entries stripped). */
    labels: string[];
    /** Project id used when the location was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A Google Business Profile location.
 *
 * Locations use a string-list `labels` field. Alchemy stamps
 * `alchemy-stack=` / `alchemy-stage=` / `alchemy-id=` entries so
 * `list` / nuke can find them.
 *
 * ### Creating a Location
 * **Example:** Storefront
 * ```typescript
 * const location = yield* GCP.Mybusinessbusinessinformation.AccountsLocation("Shop", {
 *   title: "Alchemy Test Shop",
 *   storefrontAddress: {
 *     regionCode: "US",
 *     postalCode: "94043",
 *     administrativeArea: "CA",
 *     locality: "Mountain View",
 *     addressLines: ["1600 Amphitheatre Parkway"],
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Mybusinessbusinessinformation
 */
export const AccountsLocation = Resource<AccountsLocation>(
  "GCP.Mybusinessbusinessinformation.AccountsLocation",
);

export class AccountsLocationNotResolved extends Data.TaggedError(
  "GCP.Mybusinessbusinessinformation.AccountsLocationNotResolved",
)<{
  name: string;
}> {}

const addressOf = (
  address: mybiz.PostalAddress | PostalAddress | undefined,
): PostalAddress | undefined => {
  if (address === undefined) return undefined;
  return {
    regionCode: address.regionCode,
    languageCode: address.languageCode,
    postalCode: address.postalCode,
    administrativeArea: address.administrativeArea,
    locality: address.locality,
    addressLines: address.addressLines,
  };
};

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

const toAttrs = (
  location: mybiz.Location,
  parent: string,
  project: string,
) => ({
  name: location.name ?? "",
  locationId: lastSegment(location.name ?? ""),
  parent,
  title: location.title,
  storeCode: location.storeCode,
  languageCode: location.languageCode,
  storefrontAddress: addressOf(location.storefrontAddress),
  websiteUri: location.websiteUri,
  labels: userLabels(location.labels),
  project,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mybiz
        .getLocations({ name, readMask: READ_MASK })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  mybiz.listAccountsLocations
    .pages({ parent, readMask: READ_MASK, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as mybiz.Location[]),
      ),
    );

export const AccountsLocationProvider = () =>
  Provider.succeed(AccountsLocation, {
    stables: ["name", "locationId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        news.parent !== undefined &&
        accountParent(news.parent) !== accountParent(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = accountParent(olds?.parent ?? output?.parent);
      const existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent, env.project);
      return (yield* ownedByAlchemy(id, existing.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parent = accountParent(
          process.env.GCP_MYBUSINESS_ACCOUNT?.trim(),
        );
        const locations = yield* listAt(parent);
        return locations
          .filter((location) => hasOwnershipMarker(location.labels))
          .map((location) => toAttrs(location, parent, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = accountParent(news.parent ?? output?.parent);
      const title = yield* ownedTitle(id, news.title, output?.title);
      const ownership = yield* createInternalLabels(id);
      const labels = mergeLabels(ownership, news.labels);
      const languageCode = news.languageCode ?? output?.languageCode ?? "en";

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        const created = yield* mybiz
          .createAccountsLocations({
            parent,
            body: {
              title,
              languageCode,
              storeCode: news.storeCode,
              storefrontAddress: news.storefrontAddress,
              websiteUri: news.websiteUri,
              labels,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listAt(parent).pipe(
                Effect.map((locations) =>
                  locations.find((location) => location.title === title),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AccountsLocationNotResolved({
          name: output?.name ?? title,
        });
      }

      const name = current.name ?? "";
      const titleChanged = (current.title ?? "") !== title;
      const addressChanged =
        news.storefrontAddress !== undefined &&
        jsonOf(addressOf(current.storefrontAddress)) !==
          jsonOf(news.storefrontAddress);
      const storeCodeChanged =
        news.storeCode !== undefined &&
        (current.storeCode ?? "") !== news.storeCode;
      const websiteChanged =
        news.websiteUri !== undefined &&
        (current.websiteUri ?? "") !== news.websiteUri;
      const labelsChanged =
        jsonOf([...(current.labels ?? [])].sort()) !==
        jsonOf([...labels].sort());
      const languageChanged = (current.languageCode ?? "") !== languageCode;
      const updateMask = [
        titleChanged ? "title" : undefined,
        addressChanged ? "storefrontAddress" : undefined,
        storeCodeChanged ? "storeCode" : undefined,
        websiteChanged ? "websiteUri" : undefined,
        labelsChanged ? "labels" : undefined,
        languageChanged ? "languageCode" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* mybiz.patchLocations({
          name,
          updateMask: updateMask.join(","),
          body: {
            title,
            languageCode,
            storeCode: news.storeCode,
            storefrontAddress: news.storefrontAddress,
            websiteUri: news.websiteUri,
            labels,
          },
        });
      }

      return toAttrs(current, parent, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* mybiz
        .deleteLocations({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
