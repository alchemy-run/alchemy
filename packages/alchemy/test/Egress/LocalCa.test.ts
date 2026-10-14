import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeLocalCa } from "@/Egress/LocalCa.ts";

describe("Egress.LocalCa", { tags: ["unit", "local"] }, () => {
  it.live("mints a CA and leaves it signs, one per host", () =>
    Effect.gen(function* () {
      const ca = yield* makeLocalCa;
      const [a, b] = yield* Effect.all(
        [ca.leafFor("api.github.com"), ca.leafFor("api.github.com")],
        {
          concurrency: "unbounded",
        },
      );
      // Concurrent first requests share one mint.
      expect(a).toBe(b);
      expect(yield* ca.leafFor("API.GITHUB.COM")).toBe(a);

      const { root, leaf, ip } = yield* Effect.all({
        root: Effect.sync(() => new X509Certificate(ca.pem)),
        leaf: Effect.sync(() => new X509Certificate(a.cert)),
        ip: ca.leafFor("127.0.0.1").pipe(Effect.map((l) => new X509Certificate(l.cert))),
      });
      expect(root.ca).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.issuer).toBe(root.subject);
      expect(leaf.verify(root.publicKey)).toBe(true);
      expect(leaf.subjectAltName).toBe("DNS:api.github.com");
      expect(leaf.checkHost("api.github.com")).toBe("api.github.com");
      expect(ip.checkIP("127.0.0.1")).toBe("127.0.0.1");
      expect(a.key).toContain("BEGIN PRIVATE KEY");

      // Each CA is unrelated.
      const other = yield* makeLocalCa;
      const otherRoot = yield* Effect.sync(() => new X509Certificate(other.pem));
      expect(leaf.verify(otherRoot.publicKey)).toBe(false);
    }),
  );
});
