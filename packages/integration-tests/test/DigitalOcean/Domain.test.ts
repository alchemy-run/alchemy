import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createDomain,
  deleteDomain,
  getDomain,
  listDomainRecords,
} from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isGone, logLevel, testDomain } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:domain", "live"];
const LIVE_TIMEOUT = 180_000;

const isDomainGone = (name: string) => isGone(getDomain({ domain_name: name }));

test.provider(
  "domain lifecycle: create with DigitalOcean's NS records, replace on a new name, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testDomain(stack.stage, "domain");
      const renamed = testDomain(stack.stage, "domain-renamed");

      const created = yield* stack.deploy(DigitalOcean.Domain("Zone", { name }));
      expect(created.name).toEqual(name);
      const nsRecords = yield* listDomainRecords
        .items({ domain_name: name, type: "NS" })
        .pipe(Stream.runCollect);
      expect(nsRecords.map((record) => record.data).sort()).toEqual([
        "ns1.digitalocean.com",
        "ns2.digitalocean.com",
        "ns3.digitalocean.com",
      ]);

      const replaced = yield* stack.deploy(DigitalOcean.Domain("Zone", { name: renamed }));
      expect(replaced.name).toEqual(renamed);
      expect(yield* isDomainGone(name)).toBe(true);

      yield* stack.destroy();

      expect(yield* isDomainGone(renamed)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a domain already on the team needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testDomain(stack.stage, "domain-foreign");

      yield* Effect.acquireUseRelease(
        createDomain({ name }),
        () =>
          Effect.gen(function* () {
            const refused = yield* stack
              .deploy(DigitalOcean.Domain("Adopted", { name }))
              .pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            const adopted = yield* stack.deploy(
              DigitalOcean.Domain("Adopted", { name }).pipe(adopt(true)),
            );
            expect(adopted.name).toEqual(name);

            yield* stack.destroy();

            expect(yield* isDomainGone(name)).toBe(true);
          }),
        () => ignoreNotFound(deleteDomain({ domain_name: name })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
