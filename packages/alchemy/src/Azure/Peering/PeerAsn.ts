import * as peering from "@distilled.cloud/azure/peering";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createPeeringName } from "./Common.ts";

export type PeerContactRole =
  | "Noc"
  | "Policy"
  | "Technical"
  | "Service"
  | "Escalation"
  | "Other";

/** A contact Microsoft uses to reach the network operator. */
export interface PeerContact {
  /** Role of the contact. */
  role: PeerContactRole;
  /** E-mail address of the contact. */
  email: string;
  /** Phone number of the contact. */
  phone?: string;
}

export interface PeerAsnProps {
  /**
   * Name of the peer ASN registration. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * registration.
   */
  name?: string;
  /** Autonomous system number of the peer. Changing it replaces the registration. */
  peerAsn: number;
  /** Name of the network operator that owns the ASN. */
  peerName: string;
  /** Contacts Microsoft uses to validate the ASN and operate the peering. */
  peerContactDetail: PeerContact[];
}

export interface PeerAsn extends Resource<
  "Azure.Peering.PeerAsn",
  PeerAsnProps,
  {
    /** Name of the peer ASN registration. */
    peerAsnName: string;
    /** ARM resource ID of the registration; reference it from a peering. */
    peerAsnId: string;
    /** Autonomous system number of the peer. */
    peerAsn: number;
    /** Name of the network operator. */
    peerName: string;
    /** Contacts registered with the ASN. */
    peerContactDetail: peering.ContactDetail[];
    /** Microsoft's validation state of the ASN (`Pending`, `Approved`, ...). */
    validationState: string | undefined;
    /** Validation error reported by Microsoft, if any. */
    errorMessage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A peer ASN registration — the subscription-level record of a network
 * operator's autonomous system that Microsoft (AS8075) validates before
 * the operator can create Direct or Exchange peerings. Validation is a
 * manual review by Microsoft's peering team, so register only an ASN your
 * organization owns; `validationState` reports the outcome.
 *
 * Registrations have no tags; Alchemy treats one as owned when its name is
 * the name Alchemy generates for the logical ID.
 *
 * @see https://learn.microsoft.com/azure/internet-peering/howto-subscription-association-portal
 *
 * ### Registering an ASN
 * **Example:** Associate your ASN with the subscription
 * ```typescript
 * const asn = yield* Azure.Peering.PeerAsn("contoso", {
 *   peerAsn: 65000,
 *   peerName: "Contoso Networks",
 *   peerContactDetail: [
 *     { role: "Noc", email: "noc@contoso.com", phone: "+1 555 0100" },
 *     { role: "Policy", email: "peering@contoso.com" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PeerAsn = Resource<PeerAsn>("Azure.Peering.PeerAsn");

const getPeerAsn = (subscriptionId: string, peerAsnName: string) =>
  orUndefinedIfNotFound(peering.GetPeerAsn({ subscriptionId, peerAsnName }));

const toAttrs = (
  subscriptionId: string,
  name: string,
  asn: peering.GetPeerAsnResponse,
): PeerAsn["Attributes"] => ({
  peerAsnName: name,
  peerAsnId:
    asn.id ??
    `/subscriptions/${subscriptionId}/providers/Microsoft.Peering/peerAsns/${name}`,
  peerAsn: asn.properties?.peerAsn ?? 0,
  peerName: asn.properties?.peerName ?? "",
  peerContactDetail: asn.properties?.peerContactDetail ?? [],
  validationState: asn.properties?.validationState,
  errorMessage: asn.properties?.errorMessage,
});

const contactsMatch = (
  observed: peering.ContactDetail[] | undefined,
  desired: PeerContact[],
) => {
  const key = (c: peering.ContactDetail) =>
    `${c.role ?? ""}|${(c.email ?? "").toLowerCase()}|${c.phone ?? ""}`;
  const a = (observed ?? []).map(key).sort();
  const b = desired.map(key).sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
};

export const PeerAsnProvider = () =>
  Provider.succeed(PeerAsn, {
    stables: ["peerAsnName", "peerAsnId", "peerAsn"],

    // Registrations carry no tags or markers, so `list` cannot tell
    // Alchemy-owned ones apart from the operator's own.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.peerAsnName.toLowerCase()) ||
        news.peerAsn !== output.peerAsn
      ) {
        // One registration per ASN: the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const generated = yield* createPeeringName(id);
      const name = output?.peerAsnName ?? olds?.name ?? generated;
      const observed = yield* getPeerAsn(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, name, observed);
      return name === generated || output !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const name =
        news.name ?? output?.peerAsnName ?? (yield* createPeeringName(id));

      // Observe.
      const observed = yield* getPeerAsn(subscriptionId, name);
      const props = observed?.properties;

      // Ensure + sync: the PUT is a synchronous upsert of the whole
      // registration, skipped when the observed one already matches.
      if (
        observed === undefined ||
        props === undefined ||
        props.peerName !== news.peerName ||
        !contactsMatch(props.peerContactDetail, news.peerContactDetail)
      ) {
        const written = yield* peering.PeerAsnsCreateOrUpdate({
          subscriptionId,
          peerAsnName: name,
          properties: {
            peerAsn: props?.peerAsn ?? news.peerAsn,
            peerName: news.peerName,
            peerContactDetail: news.peerContactDetail,
          },
        });
        return toAttrs(subscriptionId, name, written);
      }
      return toAttrs(subscriptionId, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getPeerAsn(subscriptionId, output.peerAsnName);
      // DELETE of a missing registration fails with HTTP 500, so only
      // delete one that is still observed.
      if ((yield* get) !== undefined) {
        yield* peering.DeletePeerAsn({
          subscriptionId,
          peerAsnName: output.peerAsnName,
        });
      }
      yield* waitUntilGone(`peer ASN ${output.peerAsnName}`, get);
    }),
  });
