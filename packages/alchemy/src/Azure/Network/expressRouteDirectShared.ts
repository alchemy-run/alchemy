import { lower } from "./common.ts";

// Shared ExpressRoute Direct (ports, LAGs) helpers. Internal: not exported
// from index.ts.

/** MACsec settings of a physical link. */
export interface ExpressRouteLinkMacSec {
  /** Key Vault secret ID of the MACsec CKN. */
  cknSecretIdentifier?: string;
  /** Key Vault secret ID of the MACsec CAK. */
  cakSecretIdentifier?: string;
  /** MACsec cipher, e.g. `"GcmAes256"`. */
  cipher?: "GcmAes128" | "GcmAes256" | "GcmAesXpn128" | "GcmAesXpn256";
  /** Whether SCI is enabled. */
  sciState?: "Enabled" | "Disabled";
}

/** Settings of one physical link (`link1`, `link2`, ...). */
export interface ExpressRouteLinkConfig {
  /** Name of the link, e.g. `"link1"`. */
  name: string;
  /** Administrative state of the physical port. */
  adminState?: "Enabled" | "Disabled";
  /** MACsec configuration. */
  macSecConfig?: ExpressRouteLinkMacSec;
}

interface ObservedLink {
  readonly name?: string;
  readonly properties?: {
    readonly adminState?: string;
    readonly macSecConfig?: {
      readonly cknSecretIdentifier?: string;
      readonly cakSecretIdentifier?: string;
      readonly cipher?: string;
      readonly sciState?: string;
    };
  };
}

/** PUT input for the declared links (`undefined` leaves links alone). */
export const linksInput = (
  links: ReadonlyArray<ExpressRouteLinkConfig> | undefined,
) =>
  links?.map((link) => ({
    name: link.name,
    properties: {
      adminState: link.adminState,
      macSecConfig: link.macSecConfig,
    },
  }));

/** Whether a declared link setting differs from the observed link. */
export const linksDrifted = (
  observed: ReadonlyArray<ObservedLink> | undefined,
  desired: ReadonlyArray<ExpressRouteLinkConfig> | undefined,
) =>
  (desired ?? []).some((link) => {
    const current = observed?.find(
      (l) => lower(l.name) === lower(link.name),
    )?.properties;
    const mac = link.macSecConfig;
    return (
      (link.adminState !== undefined &&
        lower(current?.adminState) !== lower(link.adminState)) ||
      (mac !== undefined &&
        ((mac.cknSecretIdentifier !== undefined &&
          current?.macSecConfig?.cknSecretIdentifier !==
            mac.cknSecretIdentifier) ||
          (mac.cakSecretIdentifier !== undefined &&
            current?.macSecConfig?.cakSecretIdentifier !==
              mac.cakSecretIdentifier) ||
          (mac.cipher !== undefined &&
            lower(current?.macSecConfig?.cipher) !== lower(mac.cipher)) ||
          (mac.sciState !== undefined &&
            lower(current?.macSecConfig?.sciState) !== lower(mac.sciState))))
    );
  });

/** User-assigned identity input (`undefined` when none are declared). */
export const identityInput = (ids: ReadonlyArray<string> | undefined) =>
  ids === undefined || ids.length === 0
    ? undefined
    : {
        type: "UserAssigned" as const,
        userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
      };

/** Observed user-assigned identity IDs. */
export const identityIds = (
  identity:
    | {
        readonly userAssignedIdentities?: Record<string, unknown>;
      }
    | undefined,
) => Object.keys(identity?.userAssignedIdentities ?? {});
