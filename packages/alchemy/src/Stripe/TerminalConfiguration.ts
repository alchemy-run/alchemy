import {
  DeleteTerminalConfigurationsConfiguration,
  type File as StripeFile,
  GetTerminalConfigurations,
  GetTerminalConfigurationsConfiguration,
  PostTerminalConfigurations,
  PostTerminalConfigurationsConfiguration,
  type TerminalConfiguration as StripeTerminalConfiguration,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** Device-type specific reader settings. */
export type TerminalDeviceConfig = {
  /**
   * ID of a Stripe `File` holding the image to display on the reader's
   * splash screen. Upload it with the Files API first.
   */
  splashscreen?: string;
};

/** Device-type specific reader settings as reported by Stripe. */
export type TerminalDeviceConfigAttrs = {
  /** File ID of the splash screen image, if one is configured. */
  splashscreen: string | undefined;
};

/** Currencies that support on-reader tipping configuration. */
export type TerminalTippingCurrency =
  | "aed"
  | "aud"
  | "cad"
  | "chf"
  | "czk"
  | "dkk"
  | "eur"
  | "gbp"
  | "gip"
  | "hkd"
  | "huf"
  | "jpy"
  | "mxn"
  | "myr"
  | "nok"
  | "nzd"
  | "pln"
  | "ron"
  | "sek"
  | "sgd"
  | "usd";

/** On-reader tipping options for a single currency. */
export type TerminalTippingCurrencyConfig = {
  /** Fixed tip amounts, in the currency's minor unit (e.g. cents). */
  fixedAmounts?: number[];
  /** Tip percentages offered on the reader, e.g. `[10, 15, 20]`. */
  percentages?: number[];
  /**
   * Below this amount fixed amounts are displayed; above it, percentages
   * are displayed. In the currency's minor unit.
   */
  smartTipThreshold?: number;
};

/** Per-currency on-reader tipping configuration. */
export type TerminalTippingConfig = Partial<
  Record<TerminalTippingCurrency, TerminalTippingCurrencyConfig>
>;

/** The window during which readers are allowed to reboot themselves. */
export type TerminalRebootWindow = {
  /** Integer 0–23 — the hour the reboot window opens (reader local time). */
  startHour: number;
  /** Integer 0–23 — the hour the reboot window closes. Must differ from `startHour`. */
  endHour: number;
};

/** Whether readers may collect transactions while offline. */
export type TerminalOfflineConfig = {
  /** Allow readers to take payments while disconnected from the internet. */
  enabled: boolean;
};

/** Whether cellular-capable readers may use their cellular modem. */
export type TerminalCellularConfig = {
  /** Allow a cellular-capable reader to reach the internet over cellular. */
  enabled: boolean;
};

/**
 * WiFi network credentials pushed to readers. Fill in the credential
 * object matching `type`.
 */
export type TerminalWifiConfig = {
  /** Which credential object below carries the network's credentials. */
  type: "personal_psk" | "enterprise_eap_peap" | "enterprise_eap_tls";
  /** Credentials for a WPA-Personal network. Used when `type` is `personal_psk`. */
  personalPsk?: {
    /** Name of the WiFi network. */
    ssid: string;
    /** Pre-shared key for the network. */
    password: string;
  };
  /** Credentials for a WPA-Enterprise EAP-PEAP network. */
  enterpriseEapPeap?: {
    /** Name of the WiFi network. */
    ssid: string;
    /** Username used to authenticate against the network. */
    username: string;
    /** Password used to authenticate against the network. */
    password: string;
    /** File ID of a PEM file containing the server certificate. */
    caCertificateFile?: string;
  };
  /** Credentials for a WPA-Enterprise EAP-TLS network. */
  enterpriseEapTls?: {
    /** Name of the WiFi network. */
    ssid: string;
    /** File ID of a PEM file containing the client certificate. */
    clientCertificateFile: string;
    /** File ID of a PEM file containing the client RSA private key. */
    privateKeyFile: string;
    /** Password protecting the private key file, if it is encrypted. */
    privateKeyFilePassword?: string;
    /** File ID of a PEM file containing the server certificate. */
    caCertificateFile?: string;
  };
};

export type TerminalConfigurationProps = {
  /**
   * Name of the configuration, shown in the Stripe dashboard.
   *
   * Terminal configurations carry no `metadata`, so this name is also how
   * Alchemy re-discovers the configuration if its state row is lost — keep
   * it unique within the account.
   *
   * @default - a unique name generated from `${app}-${id}-${stage}`
   */
  name?: string;
  /** Device-type specific settings for BBPOS WisePad 3 readers. */
  bbposWisepad3?: TerminalDeviceConfig;
  /** Device-type specific settings for BBPOS WisePOS E readers. */
  bbposWiseposE?: TerminalDeviceConfig;
  /** Device-type specific settings for Stripe S700 readers. */
  stripeS700?: TerminalDeviceConfig;
  /** Device-type specific settings for Stripe S710 readers. */
  stripeS710?: TerminalDeviceConfig;
  /** Device-type specific settings for Verifone M425 readers. */
  verifoneM425?: TerminalDeviceConfig;
  /** Device-type specific settings for Verifone P400 readers. */
  verifoneP400?: TerminalDeviceConfig;
  /** Device-type specific settings for Verifone P630 readers. */
  verifoneP630?: TerminalDeviceConfig;
  /** Device-type specific settings for Verifone UX700 readers. */
  verifoneUx700?: TerminalDeviceConfig;
  /** Device-type specific settings for Verifone V660p readers. */
  verifoneV660p?: TerminalDeviceConfig;
  /** Per-currency on-reader tipping configuration. */
  tipping?: TerminalTippingConfig;
  /** Whether readers may collect transactions while offline. */
  offline?: TerminalOfflineConfig;
  /** Whether cellular-capable readers may connect over cellular. */
  cellular?: TerminalCellularConfig;
  /** Reader reboot window, for readers that support scheduled reboots. */
  rebootWindow?: TerminalRebootWindow;
  /**
   * WiFi network credentials pushed to readers using this configuration.
   *
   * Stripe never returns the credentials, so Alchemy can only detect drift
   * on the network's `type` and SSID — rotating a password in place is
   * invisible. Change the SSID, or force a redeploy, to push new secrets.
   */
  wifi?: TerminalWifiConfig;
};

export type TerminalConfiguration = Resource<
  "Stripe.TerminalConfiguration",
  TerminalConfigurationProps,
  {
    /** The Stripe object ID, e.g. `tmc_1234`. */
    terminalConfigurationId: string;
    /** The configuration's name, or `undefined` if Stripe has none. */
    name: string | undefined;
    /** Whether this configuration is the account's default configuration. */
    isAccountDefault: boolean;
    /** `true` when the configuration lives in live mode rather than test mode. */
    livemode: boolean;
    /** BBPOS WisePad 3 settings Stripe has stored. */
    bbposWisepad3: TerminalDeviceConfigAttrs | undefined;
    /** BBPOS WisePOS E settings Stripe has stored. */
    bbposWiseposE: TerminalDeviceConfigAttrs | undefined;
    /** Stripe S700 settings Stripe has stored. */
    stripeS700: TerminalDeviceConfigAttrs | undefined;
    /** Stripe S710 settings Stripe has stored. */
    stripeS710: TerminalDeviceConfigAttrs | undefined;
    /** Verifone M425 settings Stripe has stored. */
    verifoneM425: TerminalDeviceConfigAttrs | undefined;
    /** Verifone P400 settings Stripe has stored. */
    verifoneP400: TerminalDeviceConfigAttrs | undefined;
    /** Verifone P630 settings Stripe has stored. */
    verifoneP630: TerminalDeviceConfigAttrs | undefined;
    /** Verifone UX700 settings Stripe has stored. */
    verifoneUx700: TerminalDeviceConfigAttrs | undefined;
    /** Verifone V660p settings Stripe has stored. */
    verifoneV660p: TerminalDeviceConfigAttrs | undefined;
    /** Per-currency tipping configuration Stripe has stored. */
    tipping: TerminalTippingConfig | undefined;
    /** Offline-transaction setting Stripe has stored. */
    offline: TerminalOfflineConfig | undefined;
    /** Cellular connectivity setting Stripe has stored. */
    cellular: TerminalCellularConfig | undefined;
    /** Reader reboot window Stripe has stored. */
    rebootWindow: TerminalRebootWindow | undefined;
    /**
     * Security type of the configured WiFi network, if any. The credentials
     * themselves are never returned by Stripe and are not persisted.
     */
    wifiType:
      | "personal_psk"
      | "enterprise_eap_peap"
      | "enterprise_eap_tls"
      | undefined;
    /** SSID of the configured WiFi network, if any. */
    wifiSsid: string | undefined;
  },
  never,
  Providers
>;

type TerminalConfigurationAttributes = TerminalConfiguration["Attributes"];

/**
 * A Stripe Terminal Configuration — the bundle of reader settings (splash
 * screens, tipping, offline mode, reboot window, WiFi) applied to the
 * readers in a fleet.
 *
 * A configuration is applied either as the account default or by pointing a
 * `Stripe.TerminalLocation`'s `configurationOverrides` at it.
 *
 * Requires Stripe Terminal to be enabled on the account.
 *
 * Terminal configurations have **no `metadata` field**, so Alchemy cannot
 * brand them the way it brands other Stripe objects. Identity after a lost
 * state row therefore comes from `name` — Alchemy generates a unique one
 * when you do not supply it, and a configuration found under a
 * *user-supplied* name is treated as foreign until you opt in with
 * `--adopt`.
 *
 * :::caution
 * Stripe refuses to delete the account's **default** configuration. If this
 * resource is the account default, destroying it logs a warning and leaves
 * the configuration in place rather than failing the destroy — promote a
 * different configuration to default first if you need it gone.
 * :::
 *
 * ### Creating a Configuration
 * **Example:** Minimal configuration
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("StoreReaders", {
 *   name: "store-readers",
 * });
 * ```
 *
 * **Example:** Tipping, offline mode, and a reboot window
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("StoreReaders", {
 *   name: "store-readers",
 *   tipping: {
 *     usd: {
 *       percentages: [10, 15, 20],
 *       fixedAmounts: [100, 200, 300],
 *       smartTipThreshold: 1000,
 *     },
 *   },
 *   offline: { enabled: true },
 *   rebootWindow: { startHour: 2, endHour: 4 },
 * });
 * ```
 *
 * ### Reader branding
 * **Example:** Per-device splash screens
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("BrandedReaders", {
 *   name: "branded-readers",
 *   bbposWiseposE: { splashscreen: "file_1234" },
 *   stripeS700: { splashscreen: "file_1234" },
 *   verifoneP400: { splashscreen: "file_1234" },
 * });
 * ```
 *
 * ### Network configuration
 * **Example:** Push WiFi credentials to the fleet
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("StoreReaders", {
 *   name: "store-readers",
 *   wifi: {
 *     type: "personal_psk",
 *     personalPsk: { ssid: "store-wifi", password: "hunter2" },
 *   },
 * });
 * ```
 *
 * ### Applying a configuration to a location
 * **Example:** Override every reader in a location
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("StoreReaders", {
 *   name: "store-readers",
 *   offline: { enabled: true },
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
 * @see https://docs.stripe.com/api/terminal/configuration
 *
 * @resource
 */
export const TerminalConfiguration = Resource<TerminalConfiguration>(
  "Stripe.TerminalConfiguration",
);

export const TerminalConfigurationProvider = () =>
  Provider.succeed(TerminalConfiguration, {
    stables: ["terminalConfigurationId"],
    list: Effect.fn(function* () {
      const configurations = yield* listAllConfigurations;
      return configurations.map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news }) {
      // `news` arrives as `Input<Props>` during plan — narrow before
      // touching any property.
      if (!isResolved(news)) return undefined;
      // Every property of a Terminal configuration is mutable in place;
      // let the engine apply its default update logic.
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.terminalConfigurationId) {
        const observed = yield* getConfiguration(
          output.terminalConfigurationId,
        );
        if (!observed) return undefined;
        return toAttributes(observed);
      }
      // State loss: Terminal configurations carry no metadata, so `name`
      // is the only identity we have. Re-discover by name.
      const name = olds?.name ?? (yield* createPhysicalName({ id }));
      const configurations = yield* listAllConfigurations;
      const match = configurations.find((c) => c.name === name);
      if (!match) return undefined;
      const attrs = toAttributes(match);
      // A generated name is unique to this stack/stage/id, so a match is
      // certainly ours. A user-supplied name could collide with somebody
      // else's configuration — gate that takeover behind `--adopt`.
      return olds?.name === undefined ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* createPhysicalName({ id }));

      // 1. Observe — `output` is only a cache of the identifier, never
      //    proof the object still exists.
      const observed = output?.terminalConfigurationId
        ? yield* getConfiguration(output.terminalConfigurationId)
        : undefined;

      // 2. Ensure — create when missing. Only defined fields are sent so
      //    Stripe applies its own defaults for the rest.
      if (!observed) {
        const created = yield* PostTerminalConfigurations({
          name,
          ...(news.bbposWisepad3 ? { bbpos_wisepad3: news.bbposWisepad3 } : {}),
          ...(news.bbposWiseposE
            ? { bbpos_wisepos_e: news.bbposWiseposE }
            : {}),
          ...(news.stripeS700 ? { stripe_s700: news.stripeS700 } : {}),
          ...(news.stripeS710 ? { stripe_s710: news.stripeS710 } : {}),
          ...(news.verifoneM425 ? { verifone_m425: news.verifoneM425 } : {}),
          ...(news.verifoneP400 ? { verifone_p400: news.verifoneP400 } : {}),
          ...(news.verifoneP630 ? { verifone_p630: news.verifoneP630 } : {}),
          ...(news.verifoneUx700 ? { verifone_ux700: news.verifoneUx700 } : {}),
          ...(news.verifoneV660p ? { verifone_v660p: news.verifoneV660p } : {}),
          ...(news.tipping ? { tipping: toTippingRequest(news.tipping) } : {}),
          ...(news.offline
            ? { offline: { enabled: news.offline.enabled } }
            : {}),
          ...(news.cellular
            ? { cellular: { enabled: news.cellular.enabled } }
            : {}),
          ...(news.rebootWindow
            ? {
                reboot_window: {
                  start_hour: news.rebootWindow.startHour,
                  end_hour: news.rebootWindow.endHour,
                },
              }
            : {}),
          ...(news.wifi ? { wifi: toWifiRequest(news.wifi) } : {}),
        });
        return toAttributes(created);
      }

      // 3. Sync — compare the desired spec against the OBSERVED cloud
      //    state and skip the API entirely on a no-op. Note that WiFi
      //    credentials are never returned by Stripe, so the comparison
      //    only covers the network type and SSID.
      if (isInSync(name, news, observed)) {
        return toAttributes(observed);
      }

      // Stripe leaves omitted parameters unchanged, so a property the user
      // removed has to be explicitly unset by posting an empty string.
      const updated = yield* PostTerminalConfigurationsConfiguration({
        configuration: observed.id,
        name,
        bbpos_wisepad3: news.bbposWisepad3 ?? "",
        bbpos_wisepos_e: news.bbposWiseposE ?? "",
        stripe_s700: news.stripeS700 ?? "",
        stripe_s710: news.stripeS710 ?? "",
        verifone_m425: news.verifoneM425 ?? "",
        verifone_p400: news.verifoneP400 ?? "",
        verifone_p630: news.verifoneP630 ?? "",
        verifone_ux700: news.verifoneUx700 ?? "",
        verifone_v660p: news.verifoneV660p ?? "",
        tipping: news.tipping ? toTippingRequest(news.tipping) : "",
        offline: news.offline ? { enabled: news.offline.enabled } : "",
        cellular: news.cellular ? { enabled: news.cellular.enabled } : "",
        reboot_window: news.rebootWindow
          ? {
              start_hour: news.rebootWindow.startHour,
              end_hour: news.rebootWindow.endHour,
            }
          : "",
        wifi: news.wifi ? toWifiRequest(news.wifi) : "",
      });

      // 4. Return — the fresh Attributes shape.
      if ("deleted" in updated) {
        // Raced with a delete; fall back to what we last observed.
        return toAttributes(observed);
      }
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DeleteTerminalConfigurationsConfiguration({
        configuration: output.terminalConfigurationId,
      }).pipe(
        Effect.asVoid,
        // Delete is idempotent — an already-deleted configuration is
        // success, not an error.
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing"
            ? Effect.void
            : // Stripe refuses to delete the account's default
              // configuration. There is no API to demote it, so the only
              // non-wedging behaviour is to leave it in place and say so.
              (e.message ?? "").toLowerCase().includes("default")
              ? Effect.logWarning(
                  `Stripe refused to delete Terminal configuration ${output.terminalConfigurationId} because it is the account default; leaving it in place.`,
                )
              : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * Fetch one configuration, mapping "missing" (and the deleted-object
 * variant of the response union) onto `undefined`.
 *
 * Stripe reports a missing object as `invalid_request_error` with HTTP 404;
 * distilled dispatches on `error.type` first, so this can surface as either
 * `NotFound` or `InvalidRequestError` with `code === "resource_missing"`.
 */
const getConfiguration = (configurationId: string) =>
  GetTerminalConfigurationsConfiguration({
    configuration: configurationId,
  }).pipe(
    Effect.map((res) => ("deleted" in res ? undefined : res)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/**
 * Exhaustively page through every Terminal configuration on the account
 * using Stripe's `starting_after` cursor. Bounded so a misbehaving cursor
 * can never spin forever.
 */
const listAllConfigurations = Effect.gen(function* () {
  const configurations: StripeTerminalConfiguration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = yield* GetTerminalConfigurations({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    configurations.push(...res.data);
    const last = res.data[res.data.length - 1];
    if (!res.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return configurations;
});

type TippingRequest = Record<
  string,
  {
    fixed_amounts?: number[];
    percentages?: number[];
    smart_tip_threshold?: number;
  }
>;

const toTippingRequest = (tipping: TerminalTippingConfig): TippingRequest => {
  const out: TippingRequest = {};
  for (const [currency, config] of Object.entries(tipping)) {
    if (!config) continue;
    out[currency] = {
      fixed_amounts: config.fixedAmounts,
      percentages: config.percentages,
      smart_tip_threshold: config.smartTipThreshold,
    };
  }
  return out;
};

const toWifiRequest = (wifi: TerminalWifiConfig) => ({
  type: wifi.type,
  ...(wifi.personalPsk
    ? {
        personal_psk: {
          ssid: wifi.personalPsk.ssid,
          password: wifi.personalPsk.password,
        },
      }
    : {}),
  ...(wifi.enterpriseEapPeap
    ? {
        enterprise_eap_peap: {
          ssid: wifi.enterpriseEapPeap.ssid,
          username: wifi.enterpriseEapPeap.username,
          password: wifi.enterpriseEapPeap.password,
          ca_certificate_file: wifi.enterpriseEapPeap.caCertificateFile,
        },
      }
    : {}),
  ...(wifi.enterpriseEapTls
    ? {
        enterprise_eap_tls: {
          ssid: wifi.enterpriseEapTls.ssid,
          client_certificate_file: wifi.enterpriseEapTls.clientCertificateFile,
          private_key_file: wifi.enterpriseEapTls.privateKeyFile,
          private_key_file_password:
            wifi.enterpriseEapTls.privateKeyFilePassword,
          ca_certificate_file: wifi.enterpriseEapTls.caCertificateFile,
        },
      }
    : {}),
});

/**
 * Whether the observed configuration already matches the desired props.
 *
 * The comparison deliberately excludes WiFi credentials (Stripe never
 * returns them) and compares tipping per declared currency, because Stripe
 * echoes back defaults for currencies the stack never mentioned — comparing
 * the whole map would report drift on every deploy.
 */
const isInSync = (
  name: string,
  news: TerminalConfigurationProps,
  observed: StripeTerminalConfiguration,
): boolean => {
  const attrs = toAttributes(observed);
  const desired = {
    name,
    bbposWisepad3: news.bbposWisepad3?.splashscreen,
    bbposWiseposE: news.bbposWiseposE?.splashscreen,
    stripeS700: news.stripeS700?.splashscreen,
    stripeS710: news.stripeS710?.splashscreen,
    verifoneM425: news.verifoneM425?.splashscreen,
    verifoneP400: news.verifoneP400?.splashscreen,
    verifoneP630: news.verifoneP630?.splashscreen,
    verifoneUx700: news.verifoneUx700?.splashscreen,
    verifoneV660p: news.verifoneV660p?.splashscreen,
    offline: news.offline?.enabled,
    cellular: news.cellular?.enabled,
    rebootWindow: news.rebootWindow,
    wifiType: news.wifi?.type,
    wifiSsid: wifiSsidOf(news.wifi),
  };
  const actual = {
    name: attrs.name,
    bbposWisepad3: attrs.bbposWisepad3?.splashscreen,
    bbposWiseposE: attrs.bbposWiseposE?.splashscreen,
    stripeS700: attrs.stripeS700?.splashscreen,
    stripeS710: attrs.stripeS710?.splashscreen,
    verifoneM425: attrs.verifoneM425?.splashscreen,
    verifoneP400: attrs.verifoneP400?.splashscreen,
    verifoneP630: attrs.verifoneP630?.splashscreen,
    verifoneUx700: attrs.verifoneUx700?.splashscreen,
    verifoneV660p: attrs.verifoneV660p?.splashscreen,
    offline: attrs.offline?.enabled,
    cellular: attrs.cellular?.enabled,
    rebootWindow: attrs.rebootWindow,
    wifiType: attrs.wifiType,
    wifiSsid: attrs.wifiSsid,
  };
  if (canonical(desired) !== canonical(actual)) return false;
  return tippingInSync(news.tipping, attrs.tipping);
};

const tippingInSync = (
  desired: TerminalTippingConfig | undefined,
  observed: TerminalTippingConfig | undefined,
): boolean => {
  if (desired === undefined) {
    // Nothing declared — only drift if Stripe is still holding one.
    return observed === undefined || Object.keys(observed).length === 0;
  }
  return Object.entries(desired).every(
    ([currency, config]) =>
      canonical(config) ===
      canonical(observed?.[currency as TerminalTippingCurrency]),
  );
};

const wifiSsidOf = (
  wifi: TerminalWifiConfig | undefined,
): string | undefined =>
  wifi === undefined
    ? undefined
    : (wifi.personalPsk?.ssid ??
      wifi.enterpriseEapPeap?.ssid ??
      wifi.enterpriseEapTls?.ssid);

/**
 * Order-independent structural comparison: sorts object keys and drops
 * `undefined`-valued entries so `{ a: undefined }` and `{}` compare equal.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );

const splashscreenId = (
  value: string | StripeFile | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : value.id;

const readerConfig = (
  config: { splashscreen?: string | StripeFile } | undefined,
): TerminalDeviceConfigAttrs | undefined =>
  config === undefined
    ? undefined
    : { splashscreen: splashscreenId(config.splashscreen) };

const toTippingAttrs = (
  tipping: StripeTerminalConfiguration["tipping"],
): TerminalTippingConfig | undefined => {
  if (tipping === undefined) return undefined;
  const out: Record<string, TerminalTippingCurrencyConfig> = {};
  for (const [currency, config] of Object.entries(tipping)) {
    if (!config) continue;
    out[currency] = {
      fixedAmounts: config.fixed_amounts ?? undefined,
      percentages: config.percentages ?? undefined,
      smartTipThreshold: config.smart_tip_threshold,
    };
  }
  return out;
};

const toAttributes = (
  configuration: StripeTerminalConfiguration,
): TerminalConfigurationAttributes => ({
  terminalConfigurationId: configuration.id,
  name: configuration.name ?? undefined,
  isAccountDefault: configuration.is_account_default ?? false,
  livemode: configuration.livemode,
  bbposWisepad3: readerConfig(configuration.bbpos_wisepad3),
  bbposWiseposE: readerConfig(configuration.bbpos_wisepos_e),
  stripeS700: readerConfig(configuration.stripe_s700),
  stripeS710: readerConfig(configuration.stripe_s710),
  verifoneM425: readerConfig(configuration.verifone_m425),
  verifoneP400: readerConfig(configuration.verifone_p400),
  verifoneP630: readerConfig(configuration.verifone_p630),
  verifoneUx700: readerConfig(configuration.verifone_ux700),
  verifoneV660p: readerConfig(configuration.verifone_v660p),
  tipping: toTippingAttrs(configuration.tipping),
  offline:
    configuration.offline === undefined
      ? undefined
      : { enabled: configuration.offline.enabled ?? false },
  cellular:
    configuration.cellular === undefined
      ? undefined
      : { enabled: configuration.cellular.enabled },
  rebootWindow:
    configuration.reboot_window === undefined
      ? undefined
      : {
          startHour: configuration.reboot_window.start_hour,
          endHour: configuration.reboot_window.end_hour,
        },
  wifiType: configuration.wifi?.type,
  wifiSsid:
    configuration.wifi?.personal_psk?.ssid ??
    configuration.wifi?.enterprise_eap_peap?.ssid ??
    configuration.wifi?.enterprise_eap_tls?.ssid,
});
