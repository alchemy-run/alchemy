import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as domain from "@distilled.cloud/modal/domain";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

// A domain you control; Modal returns the DNS records to create for it.
const domainName = process.env.MODAL_TEST_DOMAIN;

test.provider.skipIf(!domainName)(
  "register a custom domain and report its DNS records",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const registered = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Domain("Domain", { domainName: domainName! });
        }),
      );
      expect(registered.domainName).toBe(domainName);
      expect(registered.dnsRecords.length).toBeGreaterThan(0);
      const { domains } = yield* domain.listDomain({});
      expect((domains ?? []).some((d) => d.domainId === registered.domainId)).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["provider:modal", "provider:modal:domain", "live"], timeout: 120_000 },
);
