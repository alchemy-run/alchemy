import {
  DeleteTerminalReadersReader,
  type DeletedTerminalReader,
  GetTerminalReaders,
  GetTerminalReadersReader,
  PostTerminalReaders,
  PostTerminalReadersReader,
  type TerminalReader as StripeTerminalReader,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

export type TerminalReaderProps = {
  /**
   * The pairing code shown on the reader's screen (or, for a simulated
   * reader in test mode, the constant `"simulated-wpe"`).
   *
   * Create-only: Stripe consumes the code at registration, never returns it,
   * and its update endpoint does not accept it — so changing this value
   * replaces the reader.
   */
  registrationCode: Redacted.Redacted<string>;
  /**
   * The Terminal location to assign the reader to. Pass
   * `location.locationId` from a `Stripe.TerminalLocation` resource.
   *
   * Create-only: Stripe's reader update endpoint accepts only `label` and
   * `metadata`, so moving a reader between locations replaces it.
   */
  locationId?: string;
  /**
   * Human-readable label for the reader. Mutable.
   *
   * @default the registration code Stripe was given
   */
  label?: string;
  /**
   * Arbitrary key/value pairs stored on the reader. Mutable. Alchemy adds
   * its own `alchemy_stack` / `alchemy_stage` / `alchemy_id` entries
   * alongside these to mark the reader as managed by this stack; those are
   * stripped back out of the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type TerminalReader = Resource<
  "Stripe.TerminalReader",
  TerminalReaderProps,
  {
    /** Stripe's identifier for the reader, e.g. `tmr_...`. */
    readerId: string;
    /** The reader's current label. */
    label: string;
    /** The Terminal location the reader is assigned to, if any. */
    locationId: string | undefined;
    /**
     * Hardware model reported by Stripe — e.g. `bbpos_wisepos_e`,
     * `stripe_s700`, or `simulated_wisepos_e` for a simulated test reader.
     */
    deviceType: string;
    /** Serial number of the reader. */
    serialNumber: string;
    /**
     * Networking status (`online` / `offline`), or `undefined` when Stripe
     * has not reported one. Not a reliable gate for taking payments.
     */
    status: string | undefined;
    /** The reader's local IP address, when reported. */
    ipAddress: string | undefined;
    /** The reader's current software version, when reported. */
    deviceSwVersion: string | undefined;
    /**
     * Last check-in time, in **milliseconds** since the Unix epoch (unlike
     * most Stripe timestamps, which use seconds).
     */
    lastSeenAt: number | undefined;
    /** `true` when the reader is registered in Stripe's live mode. */
    livemode: boolean;
    /** User-supplied metadata, with Alchemy's internal keys removed. */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

type TerminalReaderAttributes = TerminalReader["Attributes"];

/**
 * A Stripe Terminal reader — a physical (or, in test mode, simulated) card
 * reader registered to your account and optionally assigned to a
 * `Stripe.TerminalLocation`.
 *
 * Registering a real reader requires physical hardware: you put the device
 * into pairing mode, read the code off its screen, and supply it as
 * `registrationCode`. In **test mode** Stripe accepts the constant
 * registration code `"simulated-wpe"`, which registers a simulated
 * `simulated_wisepos_e` reader with no hardware involved — that is what the
 * examples below use.
 *
 * Only `label` and `metadata` are mutable. `registrationCode` is consumed at
 * registration and never returned, and Stripe's update endpoint does not
 * accept a `location`, so a change to either of those replaces the reader.
 *
 * This resource models reader **state** only. The reader *action* endpoints
 * — `collect_payment_method`, `process_payment_intent`,
 * `process_setup_intent`, `refund_payment`, `set_reader_display`,
 * `cancel_action` — are runtime operations driven by your application during
 * a checkout, not infrastructure configuration, and are deliberately not
 * exposed here. Call them from your app with the Stripe SDK.
 *
 * ### Registering a reader
 * **Example:** A simulated reader for test mode
 * ```typescript
 * const reader = yield* Stripe.TerminalReader("CounterReader", {
 *   registrationCode: Redacted.make("simulated-wpe"),
 * });
 * ```
 *
 * **Example:** A physical reader with every prop set
 * ```typescript
 * const reader = yield* Stripe.TerminalReader("CounterReader", {
 *   registrationCode: yield* Config.redacted("STRIPE_READER_CODE"),
 *   locationId: location.locationId,
 *   label: "Front counter",
 *   metadata: { floor: "1", team: "retail" },
 * });
 * ```
 *
 * ### Assigning readers to a location
 * **Example:** A reader attached to a Terminal location
 * ```typescript
 * const location = yield* Stripe.TerminalLocation("Flagship", {
 *   displayName: "Flagship Store",
 *   address: {
 *     line1: "1 Market St",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94105",
 *     country: "US",
 *   },
 * });
 *
 * const reader = yield* Stripe.TerminalReader("FlagshipReader", {
 *   registrationCode: Redacted.make("simulated-wpe"),
 *   locationId: location.locationId,
 *   label: "Flagship counter 1",
 * });
 * ```
 *
 * ### Relabelling a reader
 * **Example:** Changing the label in place
 * ```typescript
 * // Deploying this over an existing reader updates it in place — the
 * // `readerId` is unchanged.
 * const reader = yield* Stripe.TerminalReader("FlagshipReader", {
 *   registrationCode: Redacted.make("simulated-wpe"),
 *   locationId: location.locationId,
 *   label: "Flagship counter 2",
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/terminal/readers
 *
 * @resource
 * @product Stripe
 * @category Terminal
 */
export const TerminalReader = Resource<TerminalReader>("Stripe.TerminalReader");

export const TerminalReaderProvider = () =>
  Provider.succeed(TerminalReader, {
    stables: ["readerId", "deviceType", "serialNumber", "livemode"],
    list: Effect.fn(function* () {
      const readers = yield* listAllReaders();
      return readers.map(toAttributes);
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // `olds` is absent on a greenfield plan and on adoption; the engine
      // types it as always-present, so widen it before comparing.
      const prior: TerminalReaderProps | undefined = olds;

      // The registration code is consumed at registration and never
      // returned by Stripe, so `prior` is the only baseline available. On
      // adoption there is nothing to compare and we leave the reader alone.
      const oldRegistrationCode = prior?.registrationCode;
      const oldCode =
        oldRegistrationCode === undefined
          ? undefined
          : Redacted.value(oldRegistrationCode);
      if (
        oldCode !== undefined &&
        oldCode !== Redacted.value(news.registrationCode)
      ) {
        return { action: "replace" } as const;
      }

      // Stripe's reader update endpoint accepts only `label` and
      // `metadata` — a reader cannot be moved between locations, so any
      // change (including first assigning one) replaces it. Only compare
      // once a prior generation exists.
      if (output !== undefined || prior !== undefined) {
        const oldLocationId = output?.locationId ?? prior?.locationId;
        if ((news.locationId ?? undefined) !== (oldLocationId ?? undefined)) {
          return { action: "replace" } as const;
        }
      }

      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      if (output?.readerId !== undefined) {
        const observed = yield* getReader(output.readerId);
        if (observed === undefined) return undefined;
        const attrs = toAttributes(observed);
        return (yield* isOwned(id, sanitizeMetadata(observed.metadata)))
          ? attrs
          : Unowned(attrs);
      }

      // State loss — re-discover the reader by Alchemy's branding metadata.
      const readers = yield* listAllReaders();
      for (const reader of readers) {
        if (yield* isOwned(id, sanitizeMetadata(reader.metadata))) {
          return toAttributes(reader);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — the cached id first, then a branding scan so a re-run
      //    after a failed state commit re-uses the reader we already
      //    registered instead of burning a second registration code.
      let observed =
        output?.readerId !== undefined
          ? yield* getReader(output.readerId)
          : undefined;
      if (observed === undefined) {
        const readers = yield* listAllReaders();
        for (const reader of readers) {
          if (yield* isOwned(id, sanitizeMetadata(reader.metadata))) {
            observed = reader;
            break;
          }
        }
      }

      // 2. Ensure — register the reader when it is missing.
      if (observed === undefined) {
        observed = yield* PostTerminalReaders({
          registration_code: Redacted.value(news.registrationCode),
          ...(news.locationId !== undefined
            ? { location: news.locationId }
            : {}),
          ...(news.label !== undefined ? { label: news.label } : {}),
          metadata: desiredMetadata,
        });
        return toAttributes(observed);
      }

      // 3. Sync — label and metadata are the only mutable aspects, and both
      //    are diffed against the OBSERVED reader (adoption may hand us one
      //    whose metadata bears no relation to what we last persisted).
      const observedMetadata = sanitizeMetadata(observed.metadata);
      const labelUpdate =
        news.label !== undefined && news.label !== observed.label
          ? { label: news.label }
          : {};
      const metadataChanged = !metadataEqual(observedMetadata, desiredMetadata);
      const metadataUpdatePatch = metadataChanged
        ? { metadata: metadataUpdate(observedMetadata, desiredMetadata) }
        : {};

      if (!("label" in labelUpdate) && !metadataChanged) {
        return toAttributes(observed);
      }

      const updated = yield* PostTerminalReadersReader({
        reader: observed.id,
        ...labelUpdate,
        ...metadataUpdatePatch,
      }).pipe(Effect.map(asReader));

      // A concurrent delete is the only way the update can answer with a
      // deleted object; fall back to what we observed so the attributes
      // stay well-formed and the next plan re-creates.
      return toAttributes(updated ?? observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DeleteTerminalReadersReader({ reader: output.readerId }).pipe(
        // Already deregistered — deletion is idempotent.
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          // Stripe answers a lookup/delete of a missing object with
          // `invalid_request_error` + `code: "resource_missing"`, and
          // distilled dispatches on `error.type` before HTTP status — so
          // the failure surfaces here rather than as `NotFound`.
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
        Effect.asVoid,
      );
    }),
  });

/**
 * Stripe's reader retrieve/update endpoints answer with either a reader or
 * a deleted-reader stub; only the latter carries `deleted`, which
 * discriminates the union.
 */
const asReader = (
  response: StripeTerminalReader | DeletedTerminalReader,
): StripeTerminalReader | undefined =>
  "deleted" in response ? undefined : response;

/** Fetch one reader, mapping "missing" or "deleted" onto `undefined`. */
const getReader = Effect.fn(function* (readerId: string) {
  return yield* GetTerminalReadersReader({ reader: readerId }).pipe(
    Effect.map(asReader),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );
});

/** Stripe's list pages cap at 100; bound the walk at 20 pages (2000 rows). */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

/**
 * Exhaustively enumerate the account's Terminal readers, paginating with
 * Stripe's `starting_after` cursor. Bounded so a pathological account can
 * never spin the reconciler forever.
 */
const listAllReaders = Effect.fn(function* () {
  const readers: StripeTerminalReader[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetTerminalReaders({
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    readers.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return readers;
});

/**
 * Stripe types a reader's metadata map as `string | undefined` valued.
 * Drop the undefined entries so it satisfies {@link Metadata}.
 */
const sanitizeMetadata = (
  metadata: { readonly [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/**
 * `TerminalReader.location` is `string | TerminalLocation | null` — an id
 * unless the caller expanded it. Normalize to the id.
 */
const resolveLocationId = (
  reader: StripeTerminalReader,
): string | undefined => {
  const location = reader.location;
  if (location === null || location === undefined) return undefined;
  return typeof location === "string" ? location : location.id;
};

/** Project a Stripe reader onto this resource's Attributes shape. */
const toAttributes = (
  reader: StripeTerminalReader,
): TerminalReaderAttributes => ({
  readerId: reader.id,
  label: reader.label,
  locationId: resolveLocationId(reader),
  deviceType: reader.device_type,
  serialNumber: reader.serial_number,
  status: reader.status ?? undefined,
  ipAddress: reader.ip_address ?? undefined,
  deviceSwVersion: reader.device_sw_version ?? undefined,
  lastSeenAt: reader.last_seen_at ?? undefined,
  livemode: reader.livemode,
  metadata: stripInternalMetadata(sanitizeMetadata(reader.metadata)),
});
