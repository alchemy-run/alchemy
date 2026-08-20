import {
  DeleteTerminalLocationsLocation,
  GetTerminalLocations,
  GetTerminalLocationsLocation,
  PostTerminalLocations,
  PostTerminalLocationsLocation,
  type TerminalLocation as StripeTerminalLocation,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * The physical address of a Terminal location. Stripe requires
 * `line1`, `city`, `state`, `postalCode` and `country` for most
 * countries; `country` cannot be changed after creation.
 */
export type TerminalLocationAddress = {
  /** Address line 1 — street, PO box, or company name. */
  line1: string;
  /** City, district, suburb, town, or village. */
  city: string;
  /** State, county, province, or region (ISO 3166-2). */
  state: string;
  /** ZIP or postal code. */
  postalCode: string;
  /**
   * Two-letter ISO 3166-1 alpha-2 country code, e.g. `"US"`.
   *
   * Stripe does not allow changing a location's country — changing this
   * value replaces the location.
   */
  country: string;
  /** Address line 2 — apartment, suite, unit, or building. */
  line2?: string;
};

/** The address as reported back by Stripe. Every component may be null. */
export type TerminalLocationAddressAttrs = {
  /** Address line 1 as stored by Stripe. */
  line1: string | undefined;
  /** Address line 2 as stored by Stripe. */
  line2: string | undefined;
  /** City as stored by Stripe. */
  city: string | undefined;
  /** State / province as stored by Stripe. */
  state: string | undefined;
  /** ZIP or postal code as stored by Stripe. */
  postalCode: string | undefined;
  /** Two-letter ISO 3166-1 alpha-2 country code as stored by Stripe. */
  country: string | undefined;
};

export type TerminalLocationProps = {
  /**
   * The physical address of the location. Required by Stripe.
   *
   * `address.country` is immutable — changing it replaces the location.
   * Every other component is updated in place.
   */
  address: TerminalLocationAddress;
  /**
   * Human-readable name of the location, shown in the Stripe dashboard and
   * on readers. Maximum 1000 characters.
   *
   * @default - a unique name generated from `${app}-${id}-${stage}`
   */
  displayName?: string;
  /**
   * ID of a `Stripe.TerminalConfiguration` used to customize every reader
   * registered to this location. Pass `undefined` to clear it.
   */
  configurationOverrides?: string;
  /**
   * Arbitrary key/value metadata attached to the location.
   *
   * Alchemy also writes three reserved `alchemy_*` keys used to identify
   * the objects it owns; they are stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type TerminalLocation = Resource<
  "Stripe.TerminalLocation",
  TerminalLocationProps,
  {
    /** The Stripe object ID, e.g. `tml_1234`. */
    terminalLocationId: string;
    /** The display name Stripe has stored for the location. */
    displayName: string;
    /** The address Stripe has stored for the location. */
    address: TerminalLocationAddressAttrs;
    /** ID of the configuration overriding reader settings, if any. */
    configurationOverrides: string | undefined;
    /** User metadata, with the reserved `alchemy_*` keys removed. */
    metadata: Record<string, string>;
    /** `true` when the location lives in live mode rather than test mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

type TerminalLocationAttributes = TerminalLocation["Attributes"];

/**
 * A Stripe Terminal Location — a physical place (a store, a warehouse, a
 * kiosk) that Terminal readers are registered to.
 *
 * Locations group readers for fleet management, scope connection tokens,
 * and determine which reader configuration applies. Every reader must
 * belong to exactly one location.
 *
 * Requires Stripe Terminal to be enabled on the account.
 *
 * ### Creating a Location
 * **Example:** Minimal location
 * ```typescript
 * const store = yield* Stripe.TerminalLocation("MainStore", {
 *   address: {
 *     line1: "1272 Valencia Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94110",
 *     country: "US",
 *   },
 * });
 * ```
 *
 * **Example:** Location with a display name and metadata
 * ```typescript
 * const store = yield* Stripe.TerminalLocation("MainStore", {
 *   displayName: "Mission District Store",
 *   address: {
 *     line1: "1272 Valencia Street",
 *     line2: "Suite 200",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94110",
 *     country: "US",
 *   },
 *   metadata: { region: "west", storeNumber: "17" },
 * });
 * ```
 *
 * ### Applying a reader configuration
 * **Example:** Override reader settings for every reader in the location
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("StoreReaders", {
 *   name: "store-readers",
 *   tipping: { usd: { percentages: [10, 15, 20] } },
 * });
 *
 * const store = yield* Stripe.TerminalLocation("MainStore", {
 *   displayName: "Mission District Store",
 *   configurationOverrides: config.terminalConfigurationId,
 *   address: {
 *     line1: "1272 Valencia Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94110",
 *     country: "US",
 *   },
 * });
 * ```
 *
 * ### Replacement semantics
 * **Example:** Changing the country replaces the location
 * ```typescript
 * // Stripe cannot move a location between countries. Changing
 * // `address.country` destroys the old location and creates a new one,
 * // so any readers registered to it must be re-registered.
 * const store = yield* Stripe.TerminalLocation("MainStore", {
 *   address: {
 *     line1: "10 Downing Street",
 *     city: "London",
 *     state: "London",
 *     postalCode: "SW1A 2AA",
 *     country: "GB",
 *   },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/terminal/locations
 *
 * @resource
 */
export const TerminalLocation = Resource<TerminalLocation>(
  "Stripe.TerminalLocation",
);

export const TerminalLocationProvider = () =>
  Provider.succeed(TerminalLocation, {
    stables: ["terminalLocationId"],
    list: Effect.fn(function* () {
      const locations = yield* listAllLocations;
      return locations.map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` arrives as `Input<Props>` during plan — narrow before
      // touching any property.
      if (!isResolved(news)) return undefined;
      const observedCountry = output?.address.country;
      const desiredCountry = news.address?.country;
      // Stripe explicitly refuses to change a location's country: the
      // only path is a new Location object plus re-registering readers.
      if (
        observedCountry !== undefined &&
        desiredCountry !== undefined &&
        observedCountry.toUpperCase() !== desiredCountry.toUpperCase()
      ) {
        return { action: "replace" } as const;
      }
      // Everything else (address components, display name, configuration
      // overrides, metadata) is mutable — let the engine's default update
      // logic run.
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      if (output?.terminalLocationId) {
        const observed = yield* getLocation(output.terminalLocationId);
        if (!observed) return undefined;
        return toAttributes(observed);
      }
      // State loss: re-discover the location by alchemy's metadata branding
      // so a lost state row adopts rather than duplicating.
      const locations = yield* listAllLocations;
      for (const location of locations) {
        if (yield* isOwned(id, normalizeMetadata(location.metadata))) {
          return toAttributes(location);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const displayName =
        news.displayName ?? (yield* createPhysicalName({ id }));
      const metadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` is only a cache of the identifier, never proof
      //    the object still exists.
      const observed = output?.terminalLocationId
        ? yield* getLocation(output.terminalLocationId)
        : undefined;

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* PostTerminalLocations({
          display_name: displayName,
          address: {
            line1: news.address.line1,
            line2: news.address.line2,
            city: news.address.city,
            state: news.address.state,
            postal_code: news.address.postalCode,
            country: news.address.country,
          },
          configuration_overrides: news.configurationOverrides,
          metadata,
        });
        return toAttributes(created);
      }

      // 3. Sync — diff desired against OBSERVED cloud state and issue at
      //    most one update call. Skip the API entirely on a no-op.
      const addressDrift =
        (observed.address.line1 ?? undefined) !== news.address.line1 ||
        (observed.address.line2 ?? undefined) !== news.address.line2 ||
        (observed.address.city ?? undefined) !== news.address.city ||
        (observed.address.state ?? undefined) !== news.address.state ||
        (observed.address.postal_code ?? undefined) !== news.address.postalCode;
      const displayNameDrift = observed.display_name !== displayName;
      const overridesDrift =
        (observed.configuration_overrides ?? undefined) !==
        news.configurationOverrides;
      const metadataDrift = !metadataEqual(
        normalizeMetadata(observed.metadata),
        metadata,
      );

      if (
        !addressDrift &&
        !displayNameDrift &&
        !overridesDrift &&
        !metadataDrift
      ) {
        return toAttributes(observed);
      }

      const updated = yield* PostTerminalLocationsLocation({
        location: observed.id,
        ...(addressDrift
          ? {
              address: {
                line1: news.address.line1,
                line2: news.address.line2,
                city: news.address.city,
                state: news.address.state,
                postal_code: news.address.postalCode,
                // `country` is immutable — it is only ever re-sent as the
                // value already stored, which Stripe accepts.
                country: news.address.country,
              },
            }
          : {}),
        ...(displayNameDrift ? { display_name: displayName } : {}),
        ...(overridesDrift
          ? { configuration_overrides: news.configurationOverrides ?? "" }
          : {}),
        // Stripe unsets a metadata key when it is posted as an empty
        // string, so removals must be blanked explicitly.
        ...(metadataDrift
          ? {
              metadata: metadataUpdate(
                normalizeMetadata(observed.metadata),
                metadata,
              ),
            }
          : {}),
      });

      // 4. Return — the fresh Attributes shape.
      if ("deleted" in updated) {
        // Raced with a delete; fall back to what we know.
        return toAttributes({ ...observed, metadata });
      }
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Terminal locations are fully deletable. Delete is idempotent: an
      // already-deleted location is success, not an error.
      yield* DeleteTerminalLocationsLocation({
        location: output.terminalLocationId,
      }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * Fetch one location, mapping "missing" (and the deleted-object variant of
 * the response union) onto `undefined`.
 *
 * Stripe reports a missing object as `invalid_request_error` with HTTP 404;
 * distilled dispatches on `error.type` first, so this can surface as either
 * `NotFound` or `InvalidRequestError` with `code === "resource_missing"`.
 */
const getLocation = (locationId: string) =>
  GetTerminalLocationsLocation({ location: locationId }).pipe(
    Effect.map((res) => ("deleted" in res ? undefined : res)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/**
 * Exhaustively page through every Terminal location on the account using
 * Stripe's `starting_after` cursor. Bounded so a misbehaving cursor can
 * never spin forever.
 */
const listAllLocations = Effect.gen(function* () {
  const locations: StripeTerminalLocation[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = yield* GetTerminalLocations({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    locations.push(...res.data);
    const last = res.data[res.data.length - 1];
    if (!res.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return locations;
});

/**
 * Stripe's generated metadata maps are typed `{ [key: string]: string |
 * undefined }`; alchemy's metadata helpers operate on `Record<string,
 * string>`. Drop the undefined-valued entries at the boundary.
 */
const normalizeMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const toAttributes = (
  location: StripeTerminalLocation,
): TerminalLocationAttributes => ({
  terminalLocationId: location.id,
  displayName: location.display_name,
  address: {
    line1: location.address.line1 ?? undefined,
    line2: location.address.line2 ?? undefined,
    city: location.address.city ?? undefined,
    state: location.address.state ?? undefined,
    postalCode: location.address.postal_code ?? undefined,
    country: location.address.country ?? undefined,
  },
  configurationOverrides: location.configuration_overrides,
  metadata: stripInternalMetadata(normalizeMetadata(location.metadata)),
  livemode: location.livemode,
});
