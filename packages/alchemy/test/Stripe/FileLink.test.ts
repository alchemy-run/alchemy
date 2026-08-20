import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetFileLinksLink, PostFiles } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * A 1x1 transparent PNG, checked in as a constant so the upload payload is
 * byte-identical on every run. Stripe only allows file links for a fixed set
 * of `purpose` values — `dispute_evidence` is the least entitlement-gated
 * one that accepts an image.
 */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const pngBytes = Effect.sync(() =>
  Uint8Array.from(atob(PNG_1X1_BASE64), (char) => char.charCodeAt(0)),
);

/**
 * Upload a file to Stripe so a link has something to point at.
 *
 * `STRIPE_TEST_FILE_ID` short-circuits the upload with an existing, linkable
 * file id — useful when the account's file-upload endpoint is unavailable.
 * Stripe has no delete API for files, so every upload here is permanent
 * (test-mode) clutter; the tests upload only when they must.
 */
const uploadFile = (filename: string) =>
  Effect.gen(function* () {
    const override = yield* Effect.sync(() => process.env.STRIPE_TEST_FILE_ID);
    if (override) return override;
    const bytes = yield* pngBytes;
    const file = yield* PostFiles({
      purpose: "dispute_evidence",
      // DISTILLED GAP: the generated `PostFilesRequest` types `file` as
      // `string`, but the operation is `contentType: "multipart"` and the
      // shared request builder appends a `File`/`Blob` value as the binary
      // part (see distilled/packages/core/src/protocol-http.ts). The schema
      // should model this member as a blob.
      file: new File([bytes], filename, {
        type: "image/png",
      }) as unknown as string,
    });
    return file.id;
  });

/** A Unix timestamp (seconds) `days` days from now — Stripe rejects a past `expires_at`. */
const daysFromNow = (days: number) =>
  Effect.sync(() => Math.floor(Date.now() / 1000) + days * 86_400);

test.provider("create a file link with only a file id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const fileId = yield* uploadFile("alchemy-file-link-minimal.png");

    const link = yield* stack.deploy(
      Stripe.FileLink("MinimalLink", { fileId }),
    );

    expect(link.fileLinkId).toBeDefined();
    expect(link.fileLinkId.startsWith("link_")).toBe(true);
    expect(link.fileId).toEqual(fileId);
    expect(link.url).toBeDefined();
    expect(link.url).toContain("files.stripe.com");
    expect(link.expired).toBe(false);
    expect(link.expiresAt).toBeUndefined();
    expect(link.livemode).toBe(false);
    // Alchemy's `alchemy_*` branding never leaks into the user-facing attr.
    expect(link.metadata).toEqual({});

    const fetched = yield* GetFileLinksLink({ link: link.fileLinkId });
    expect(fetched.id).toEqual(link.fileLinkId);
    expect(fetched.expired).toBe(false);
    expect(fetched.expires_at).toBeNull();
    // The branding IS present on Stripe — that's how `read` re-discovers the
    // link after state loss.
    expect(fetched.metadata.alchemy_id).toEqual("MinimalLink");

    yield* stack.destroy();
  }),
);

test.provider("create a fully configured file link", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const fileId = yield* uploadFile("alchemy-file-link-full.png");
    const expiresAt = yield* daysFromNow(2);

    const link = yield* stack.deploy(
      Stripe.FileLink("FullLink", {
        fileId,
        expiresAt,
        metadata: { purpose: "dispute-evidence", team: "risk" },
      }),
    );

    expect(link.fileId).toEqual(fileId);
    expect(link.expiresAt).toEqual(expiresAt);
    expect(link.expired).toBe(false);
    expect(link.metadata).toEqual({
      purpose: "dispute-evidence",
      team: "risk",
    });

    const fetched = yield* GetFileLinksLink({ link: link.fileLinkId });
    expect(fetched.expires_at).toEqual(expiresAt);
    expect(fetched.metadata.purpose).toEqual("dispute-evidence");
    expect(fetched.metadata.team).toEqual("risk");
    expect(fetched.metadata.alchemy_id).toEqual("FullLink");

    yield* stack.destroy();
  }),
);

test.provider("update expiry and metadata in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const fileId = yield* uploadFile("alchemy-file-link-update.png");
    const firstExpiry = yield* daysFromNow(1);
    const secondExpiry = yield* daysFromNow(7);

    const created = yield* stack.deploy(
      Stripe.FileLink("UpdatedLink", {
        fileId,
        expiresAt: firstExpiry,
        metadata: { stage: "one", drop: "me" },
      }),
    );
    expect(created.expiresAt).toEqual(firstExpiry);
    expect(created.metadata).toEqual({ stage: "one", drop: "me" });

    const updated = yield* stack.deploy(
      Stripe.FileLink("UpdatedLink", {
        fileId,
        expiresAt: secondExpiry,
        metadata: { stage: "two" },
      }),
    );

    // Same link — expiry and metadata are mutable, so this is an update.
    expect(updated.fileLinkId).toEqual(created.fileLinkId);
    expect(updated.url).toEqual(created.url);
    expect(updated.expiresAt).toEqual(secondExpiry);
    expect(updated.expired).toBe(false);
    expect(updated.metadata).toEqual({ stage: "two" });

    const fetched = yield* GetFileLinksLink({ link: updated.fileLinkId });
    expect(fetched.expires_at).toEqual(secondExpiry);
    expect(fetched.metadata.stage).toEqual("two");
    // Removed keys are explicitly unset on Stripe, not merely left behind.
    expect(fetched.metadata.drop).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider("clear the expiry by removing the prop", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const fileId = yield* uploadFile("alchemy-file-link-clear.png");
    const expiresAt = yield* daysFromNow(3);

    const created = yield* stack.deploy(
      Stripe.FileLink("ClearedLink", { fileId, expiresAt }),
    );
    expect(created.expiresAt).toEqual(expiresAt);

    const cleared = yield* stack.deploy(
      Stripe.FileLink("ClearedLink", { fileId }),
    );
    expect(cleared.fileLinkId).toEqual(created.fileLinkId);
    expect(cleared.expiresAt).toBeUndefined();
    expect(cleared.expired).toBe(false);

    const fetched = yield* GetFileLinksLink({ link: cleared.fileLinkId });
    expect(fetched.expires_at).toBeNull();

    yield* stack.destroy();
  }),
);

test.provider('expire a link immediately with expiresAt: "now"', (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const fileId = yield* uploadFile("alchemy-file-link-now.png");

    const live = yield* stack.deploy(
      Stripe.FileLink("ExpiredNowLink", { fileId }),
    );
    expect(live.expired).toBe(false);

    const expired = yield* stack.deploy(
      Stripe.FileLink("ExpiredNowLink", { fileId, expiresAt: "now" }),
    );
    expect(expired.fileLinkId).toEqual(live.fileLinkId);
    expect(expired.expired).toBe(true);
    expect(expired.expiresAt).toBeDefined();

    const fetched = yield* GetFileLinksLink({ link: expired.fileLinkId });
    expect(fetched.expired).toBe(true);

    // Re-asserting `"now"` on an already-expired link is a no-op, not a
    // replacement and not an (illegal) update.
    const again = yield* stack.deploy(
      Stripe.FileLink("ExpiredNowLink", { fileId, expiresAt: "now" }),
    );
    expect(again.fileLinkId).toEqual(expired.fileLinkId);
    expect(again.expired).toBe(true);

    yield* stack.destroy();
  }),
);

// A replacement needs two distinct files; `STRIPE_TEST_FILE_ID` pins both
// uploads to the same one, so this case only runs against real uploads.
test.provider.skipIf(!!process.env.STRIPE_TEST_FILE_ID)(
  "changing the file replaces the link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const firstFileId = yield* uploadFile("alchemy-file-link-replace-a.png");
      const secondFileId = yield* uploadFile("alchemy-file-link-replace-b.png");
      expect(secondFileId).not.toEqual(firstFileId);

      const created = yield* stack.deploy(
        Stripe.FileLink("ReplacedLink", { fileId: firstFileId }),
      );
      expect(created.fileId).toEqual(firstFileId);

      const replaced = yield* stack.deploy(
        Stripe.FileLink("ReplacedLink", { fileId: secondFileId }),
      );

      // A file link is permanently bound to its file — a new link is created
      // and the old one expired.
      expect(replaced.fileLinkId).not.toEqual(created.fileLinkId);
      expect(replaced.fileId).toEqual(secondFileId);
      expect(replaced.expired).toBe(false);

      const old = yield* GetFileLinksLink({ link: created.fileLinkId });
      expect(old.expired).toBe(true);

      yield* stack.destroy();
    }),
);

test.provider("destroying a link expires it rather than deleting it", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const fileId = yield* uploadFile("alchemy-file-link-destroy.png");

    const link = yield* stack.deploy(
      Stripe.FileLink("DestroyedLink", { fileId }),
    );
    expect(link.expired).toBe(false);

    yield* stack.destroy();

    // Stripe has no delete API for file links: the object survives, expired.
    const fetched = yield* GetFileLinksLink({ link: link.fileLinkId });
    expect(fetched.id).toEqual(link.fileLinkId);
    expect(fetched.expired).toBe(true);
    expect(fetched.expires_at).not.toBeNull();

    // A second destroy is a no-op — deleting an already-expired link must
    // not error.
    yield* stack.destroy();
  }),
);
