import type {
  FileLink as StripeFileLink,
  PostFileLinksLinkRequest,
} from "@distilled.cloud/stripe/stripe";
import {
  GetFileLinks,
  GetFileLinksLink,
  PostFileLinks,
  PostFileLinksLink,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
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

/**
 * When the link stops working.
 *
 * - a Unix timestamp (seconds) in the future — the link expires then.
 * - `"now"` — expire the link immediately.
 */
export type FileLinkExpiresAt = number | "now";

export type FileLinkProps = {
  /**
   * ID of the Stripe {@link https://docs.stripe.com/api/files | File} the
   * link points at.
   *
   * Only files uploaded with a *linkable* `purpose` can be linked —
   * `business_icon`, `business_logo`, `customer_signature`,
   * `dispute_evidence`, `finance_report_run`,
   * `financial_account_statement`, `identity_document_downloadable`,
   * `issuing_regulatory_reporting`, `pci_document`, `selfie`,
   * `sigma_scheduled_query`, `tax_document_user_upload`,
   * `terminal_android_apk` or `terminal_reader_splashscreen`. Stripe
   * rejects the create with `invalid_request_error` for any other purpose.
   *
   * A file link can never be re-pointed at a different file, so changing
   * this replaces the resource.
   */
  fileId: string;
  /**
   * When the link stops being usable — a future Unix timestamp (seconds),
   * or the literal `"now"` to expire it immediately.
   *
   * Mutable — changing it updates the existing link in place. Removing the
   * prop clears the expiry so the link never expires. `"now"` can only be
   * applied to a link that is not already expired; alchemy creates the link
   * first and expires it in a follow-up call.
   *
   * @default undefined — the link never expires
   */
  expiresAt?: FileLinkExpiresAt;
  /**
   * Arbitrary key/value pairs attached to the link. Alchemy additionally
   * writes its own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys to
   * brand ownership; those are stripped from the returned `metadata`
   * attribute.
   *
   * Mutable — changing it updates the existing link in place. Keys the user
   * removes are explicitly unset on Stripe.
   */
  metadata?: Record<string, string>;
};

export type FileLink = Resource<
  "Stripe.FileLink",
  FileLinkProps,
  {
    /** The file link's Stripe ID (`link_…`). */
    fileLinkId: string;
    /**
     * The publicly accessible URL that downloads the file — the reason this
     * resource exists. `undefined` on the rare link Stripe has not minted a
     * URL for.
     */
    url: string | undefined;
    /** Whether the link has already expired and no longer serves the file. */
    expired: boolean;
    /**
     * Unix timestamp (seconds) at which the link expires, or `undefined`
     * when it never expires.
     */
    expiresAt: number | undefined;
    /** ID of the file the link points at. */
    fileId: string;
    /** `true` when the link lives in live mode rather than test mode. */
    livemode: boolean;
    /** Unix timestamp (seconds) at which the link was created. */
    created: number;
    /** User metadata, with Alchemy's internal `alchemy_*` keys stripped. */
    metadata: Metadata;
  },
  never,
  Providers
>;

type FileLinkAttributes = FileLink["Attributes"];

/**
 * A publicly downloadable URL for a file you uploaded to Stripe.
 *
 * Files uploaded to Stripe are private by default — a file link mints a
 * shareable `https://files.stripe.com/links/…` URL that serves the file's
 * contents to anyone who has it, optionally until a deadline you set.
 *
 * :::caution
 * Stripe does not support deleting a file link. Destroying this resource
 * expires the link instead (`expires_at: "now"`), which immediately stops
 * the URL from serving the file — but the link object remains visible in
 * the dashboard and in `GET /v1/file_links` forever.
 * :::
 *
 * Only files whose `purpose` is linkable can be linked (`business_logo`,
 * `dispute_evidence`, `pci_document`, `terminal_reader_splashscreen`, …).
 * Pointing a link at a file with any other purpose is rejected by Stripe.
 *
 * ### Creating a File Link
 * **Example:** A permanent public URL for an uploaded file
 * ```typescript
 * const link = yield* Stripe.FileLink("LogoLink", {
 *   fileId: "file_1234567890",
 * });
 * // link.url → "https://files.stripe.com/links/..."
 * ```
 *
 * ### Expiring the link
 * **Example:** A link that stops working at a fixed time
 * ```typescript
 * const link = yield* Stripe.FileLink("EvidenceLink", {
 *   fileId: "file_1234567890",
 *   expiresAt: 1767225600, // 2026-01-01T00:00:00Z
 *   metadata: { dispute: "dp_123" },
 * });
 * ```
 *
 * **Example:** Kill an already-published link without destroying the resource
 * ```typescript
 * const link = yield* Stripe.FileLink("EvidenceLink", {
 *   fileId: "file_1234567890",
 *   expiresAt: "now",
 * });
 * // link.expired → true
 * ```
 *
 * Removing `expiresAt` again on a *non-expired* link clears the deadline.
 * An expired link can never be revived — Stripe refuses every update to it,
 * so alchemy replaces the resource with a fresh link instead.
 *
 * ### Composing with other Stripe resources
 * **Example:** Serve a hosted logo to a payment link's branding
 * ```typescript
 * const logo = yield* Stripe.FileLink("BrandLogo", {
 *   fileId: "file_1234567890",
 *   metadata: { role: "brand-logo" },
 * });
 * const product = yield* Stripe.Product("Pro", {
 *   name: "Pro Plan",
 *   images: [logo.url ?? ""],
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/file_links
 *
 * @resource
 */
export const FileLink = Resource<FileLink>("Stripe.FileLink");

export const FileLinkProvider = () =>
  Provider.succeed(FileLink, {
    stables: ["fileLinkId", "fileId", "livemode", "created"],
    list: Effect.fn(function* () {
      const links = yield* listAllFileLinks;
      return links.map(fileLinkAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` arrives as `Input<FileLinkProps>` during plan — bail out
      // until every referenced Output has been resolved.
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // A link is permanently bound to its file.
      if (news.fileId !== output.fileId) return { action: "replace" } as const;
      // Stripe refuses every update to an expired link ("Expired links can
      // no longer be updated"), so any desired change to one has to be a
      // create-then-expire of a brand new link. Re-asserting `"now"` on an
      // already-expired link is NOT a change.
      if (output.expired) {
        const expiresChanged =
          news.expiresAt === "now"
            ? false
            : (news.expiresAt ?? undefined) !== (output.expiresAt ?? undefined);
        const metadataChanged = !metadataEqual(
          news.metadata ?? {},
          output.metadata,
        );
        if (expiresChanged || metadataChanged) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      if (output?.fileLinkId !== undefined) {
        const link = yield* getFileLink(output.fileLinkId);
        return link === undefined ? undefined : fileLinkAttributes(link);
      }
      // State loss: Stripe generates the link id and a file link has no
      // user-chosen natural key, so the only handle left is the `alchemy_*`
      // branding written into the link's metadata. An unbranded link that
      // happens to point at the same file is somebody else's and is simply
      // not found — there is no `Unowned` adoption path for this type.
      const links = yield* listAllFileLinks;
      for (const link of links) {
        if (yield* isOwned(id, toMetadata(link.metadata))) {
          return fileLinkAttributes(link);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output.fileLinkId` is a cache for the id, never proof
      //    the link still exists.
      const observed =
        output?.fileLinkId !== undefined
          ? yield* getFileLink(output.fileLinkId)
          : undefined;

      // 2. Ensure — create when absent. `POST /v1/file_links` only accepts a
      //    future timestamp for `expires_at`, so `"now"` is applied by the
      //    sync step below against the freshly created link.
      const existing =
        observed ??
        (yield* PostFileLinks({
          file: news.fileId,
          ...(typeof news.expiresAt === "number"
            ? { expires_at: news.expiresAt }
            : {}),
          metadata: desiredMetadata,
        }));

      // 3. Sync — diff both mutable aspects against OBSERVED state and issue
      //    at most one update call. `diff` routes a *changed* expired link to
      //    a replacement (Stripe refuses to update one), so anything that
      //    reaches here with `existing.expired` is already converged; the
      //    `"now"` branch below is the only expired-tolerant delta.
      const update: PostFileLinksLinkRequest = { link: existing.id };
      let changed = false;

      if (!metadataEqual(toMetadata(existing.metadata), desiredMetadata)) {
        update.metadata = metadataUpdate(
          toMetadata(existing.metadata),
          desiredMetadata,
        );
        changed = true;
      }

      if (news.expiresAt === "now") {
        // Idempotent: an already-expired link needs (and tolerates) nothing.
        if (!existing.expired) {
          update.expires_at = "now";
          changed = true;
        }
      } else if (news.expiresAt !== undefined) {
        if (existing.expires_at !== news.expiresAt) {
          update.expires_at = news.expiresAt;
          changed = true;
        }
      } else if (existing.expires_at !== null) {
        // Desired state has no deadline — Stripe unsets the field when the
        // empty string is posted.
        update.expires_at = "";
        changed = true;
      }

      if (!changed) return fileLinkAttributes(existing);
      return fileLinkAttributes(yield* PostFileLinksLink(update));
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe has no `DELETE /v1/file_links/{link}` — expiring the link is
      // the closest thing to a delete. Idempotent: a link already gone, or
      // already expired (by a prior destroy, by its own deadline, or out of
      // band) is success.
      const observed = yield* getFileLink(output.fileLinkId);
      if (observed === undefined || observed.expired) return;
      yield* PostFileLinksLink({
        link: output.fileLinkId,
        expires_at: "now",
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          // The link expired between the observe and this call, or was
          // removed outright.
          e.code === "resource_missing" ||
          (e.message ?? "").toLowerCase().includes("expired")
            ? Effect.void
            : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * `GET /v1/file_links/{link}`, mapping a missing link to `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing` at HTTP 404, and distilled dispatches on `error.type`
 * before status — so the miss can arrive as either tag.
 */
const getFileLink = (fileLinkId: string) =>
  GetFileLinksLink({ link: fileLinkId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/**
 * Exhaustively enumerate the account's file links via Stripe's
 * `starting_after` cursor. Bounded at 100 pages (10k links) so a
 * misbehaving cursor can never spin forever.
 */
const listAllFileLinks = Effect.gen(function* () {
  const links: StripeFileLink[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = yield* GetFileLinks({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    links.push(...res.data);
    const last = res.data[res.data.length - 1];
    if (!res.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return links;
});

/**
 * Stripe's metadata maps are typed `string | undefined` per key; alchemy's
 * {@link Metadata} is a dense `Record<string, string>`.
 */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const fileLinkAttributes = (link: StripeFileLink): FileLinkAttributes => ({
  fileLinkId: link.id,
  url: link.url ?? undefined,
  expired: link.expired,
  expiresAt: link.expires_at ?? undefined,
  // `file` is expandable — a bare id unless the caller asked Stripe to
  // inline the whole File object.
  fileId: typeof link.file === "string" ? link.file : link.file.id,
  livemode: link.livemode,
  created: link.created,
  metadata: stripInternalMetadata(toMetadata(link.metadata)),
});
