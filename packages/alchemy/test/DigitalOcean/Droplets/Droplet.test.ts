import * as DigitalOcean from "@/DigitalOcean";
import {
  driftedReplacingProps,
  ownershipTag,
} from "@/DigitalOcean/Droplets/Droplet";
import * as Provider from "@/Provider";
import { State } from "@/State/State";
import * as Test from "@/Test/Alchemy";
import { dropletsDestroy, getDroplet } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, outOfBand, skipLive } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

type DropletProps = DigitalOcean.DropletProps;
type DropletAttributes = DigitalOcean.Droplet["Attributes"];

const DROPLET_NAME = "alchemy-test-droplet";
const RENAMED_DROPLET_NAME = "alchemy-test-droplet-renamed";
// The smallest size that exists in every region. A live droplet costs
// money. The suite creates one droplet and always destroys it.
const REGION = "sfo3";
const SIZE = "s-1vcpu-512mb-10gb";
const IMAGE = "ubuntu-24-04-x64";
// Twice the longest wait of the provider (DROPLET_POLL: 60 × 5 seconds).
const LIVE_TIMEOUT = 600_000;

const PROPS: DropletProps = { region: REGION, size: SIZE, image: IMAGE };

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const observed = (
  overrides: Partial<DropletAttributes> = {},
): DropletAttributes => ({
  dropletId: 1,
  name: "web",
  status: "active",
  region: REGION,
  sizeSlug: SIZE,
  imageId: 100,
  imageSlug: IMAGE,
  ipv4: "1.2.3.4",
  privateIpv4: undefined,
  ipv6: undefined,
  vpcUuid: undefined,
  features: [],
  tags: [],
  createdAt: daysAgo(1),
  ...overrides,
});

const diff = (input: {
  olds: DropletProps | undefined;
  news: DropletProps;
  output: DropletAttributes | undefined;
}) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DigitalOcean.Droplet);
    return yield* provider.diff!({
      id: "web",
      fqn: "web",
      instanceId: "instance",
      oldBindings: [],
      newBindings: [],
      olds: input.olds as DropletProps,
      news: input.news,
      output: input.output,
    });
  });

const REPLACE = { action: "replace", deleteFirst: true };

describe("Droplet diff", () => {
  test.provider("replaceAfter replaces a droplet older than the limit", () =>
    Effect.gen(function* () {
      const props = { ...PROPS, replaceAfter: "30 days" as const };
      const result = yield* diff({
        olds: { ...props },
        news: props,
        output: observed({ createdAt: daysAgo(31) }),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  test.provider("replaceAfter keeps a droplet younger than the limit", () =>
    Effect.gen(function* () {
      const props = { ...PROPS, replaceAfter: "30 days" as const };
      const result = yield* diff({
        olds: { ...props },
        news: props,
        output: observed({ createdAt: daysAgo(29) }),
      });
      expect(result).toBeUndefined();
    }),
  );

  test.provider("replaceAfter ignores an unreadable createdAt", () =>
    Effect.gen(function* () {
      const props = { ...PROPS, replaceAfter: "30 days" as const };
      const result = yield* diff({
        olds: { ...props },
        news: props,
        output: observed({ createdAt: "not-a-date" }),
      });
      expect(result).toBeUndefined();
    }),
  );

  test.provider("replaceAfter does not apply without prior props", () =>
    Effect.gen(function* () {
      const props = { ...PROPS, replaceAfter: "30 days" as const };
      const result = yield* diff({
        olds: undefined,
        news: props,
        output: observed({ createdAt: daysAgo(31) }),
      });
      expect(result).toBeUndefined();
    }),
  );

  test.provider(
    "adoption replaces when create-time props differ from the droplet",
    () =>
      Effect.gen(function* () {
        const news = { ...PROPS };
        const result = yield* diff({
          olds: news,
          news,
          output: observed({ region: "nyc3", createdAt: daysAgo(31) }),
        });
        expect(result).toEqual(REPLACE);
      }),
  );

  test.provider("a copy of the prior props still sees observed drift", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS },
        output: observed({ sizeSlug: "s-2vcpu-4gb" }),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  test.provider("adoption keeps a droplet that matches its props", () =>
    Effect.gen(function* () {
      const news = { ...PROPS, image: 100 };
      const result = yield* diff({ olds: news, news, output: observed() });
      expect(result).toBeUndefined();
    }),
  );

  test.provider("a droplet without an image slug does not drift", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS },
        output: observed({ imageSlug: undefined }),
      });
      expect(result).toBeUndefined();
    }),
  );

  test.provider("clearing withDropletAgent replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, withDropletAgent: undefined },
        news: { ...PROPS, withDropletAgent: false },
        output: observed(),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  test.provider("omitting a defaulted boolean is not a change", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, backups: false },
        news: { ...PROPS, backups: undefined },
        output: observed(),
      });
      expect(result).toBeUndefined();
    }),
  );

  test.provider("name and tags update in place", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, name: "a", tags: ["x"] },
        news: { ...PROPS, name: "b", tags: ["x", "y"] },
        output: observed(),
      });
      expect(result).toEqual({ action: "update" });
    }),
  );
});

describe("driftedReplacingProps", () => {
  const cases: Array<{
    name: string;
    news: DropletProps;
    droplet: DropletAttributes;
    expected: string[];
  }> = [
    {
      name: "matching droplet",
      news: PROPS,
      droplet: observed(),
      expected: [],
    },
    {
      name: "image given as a matching number",
      news: { ...PROPS, image: 100 },
      droplet: observed(),
      expected: [],
    },
    {
      name: "image given as a different number",
      news: { ...PROPS, image: 101 },
      droplet: observed(),
      expected: ["image"],
    },
    {
      name: "image slug unknown on the droplet",
      news: PROPS,
      droplet: observed({ imageSlug: undefined }),
      expected: [],
    },
    {
      name: "different image slug",
      news: { ...PROPS, image: "debian-13-x64" },
      droplet: observed(),
      expected: ["image"],
    },
    {
      name: "region and size differ",
      news: { ...PROPS, region: "nyc3", size: "s-2vcpu-4gb" },
      droplet: observed(),
      expected: ["region", "size"],
    },
    {
      name: "features enabled on the droplet but not desired",
      news: PROPS,
      droplet: observed({ features: ["backups", "ipv6", "monitoring"] }),
      expected: ["backups", "ipv6", "monitoring"],
    },
    {
      name: "features desired and enabled",
      news: { ...PROPS, backups: true, ipv6: true, monitoring: true },
      droplet: observed({ features: ["backups", "ipv6", "monitoring"] }),
      expected: [],
    },
    {
      name: "vpc only checked when desired",
      news: PROPS,
      droplet: observed({ vpcUuid: "vpc-1" }),
      expected: [],
    },
    {
      name: "different vpc",
      news: { ...PROPS, vpcUuid: "vpc-2" },
      droplet: observed({ vpcUuid: "vpc-1" }),
      expected: ["vpcUuid"],
    },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(driftedReplacingProps(testCase.news, testCase.droplet)).toEqual(
        testCase.expected,
      );
    });
  }
});

describe("ownershipTag", () => {
  it.effect("is stable and fits DigitalOcean's tag rules", () =>
    Effect.gen(function* () {
      const tag = yield* ownershipTag("stack", "stage", "id");
      expect(tag).toEqual(yield* ownershipTag("stack", "stage", "id"));
      expect(tag.startsWith("alchemy:")).toBe(true);
      expect(tag).toMatch(/^[a-zA-Z0-9:_-]+$/);
      expect(tag.length).toBeLessThanOrEqual(255);
    }),
  );

  it.effect("does not collide on names that differ only in punctuation", () =>
    Effect.gen(function* () {
      expect(yield* ownershipTag("api.prod", "s", "id")).not.toEqual(
        yield* ownershipTag("api-prod", "s", "id"),
      );
    }),
  );

  it.effect("does not collide when the tuple boundaries move", () =>
    Effect.gen(function* () {
      expect(yield* ownershipTag("a:b", "c", "id")).not.toEqual(
        yield* ownershipTag("a", "b:c", "id"),
      );
    }),
  );
});

const droplet = (name: string, tags: string[]) =>
  Effect.gen(function* () {
    return yield* DigitalOcean.Droplet("TestDroplet", {
      name,
      region: REGION,
      size: SIZE,
      image: IMAGE,
      tags,
    });
  });

test.provider.skipIf(skipLive)(
  "droplet lifecycle: create active with an IP, rename and retag in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        droplet(DROPLET_NAME, ["alchemy-test"]),
      );
      expect(created.name).toEqual(DROPLET_NAME);
      expect(created.status).toEqual("active");
      expect(created.region).toEqual(REGION);
      expect(created.sizeSlug).toEqual(SIZE);
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.tags).toEqual(["alchemy-test"]);

      const remote = yield* getDroplet({ droplet_id: created.dropletId }).pipe(
        outOfBand,
      );
      expect(remote.droplet.name).toEqual(DROPLET_NAME);
      expect([...remote.droplet.tags].sort()).toEqual(
        [
          "alchemy-test",
          yield* ownershipTag(stack.name, "test", "TestDroplet"),
        ].sort(),
      );

      const renamed = yield* stack.deploy(
        droplet(RENAMED_DROPLET_NAME, ["alchemy-test", "alchemy-test-extra"]),
      );
      expect(renamed.dropletId).toEqual(created.dropletId);
      expect(renamed.name).toEqual(RENAMED_DROPLET_NAME);
      expect(renamed.ipv4).toEqual(created.ipv4);
      expect([...renamed.tags].sort()).toEqual([
        "alchemy-test",
        "alchemy-test-extra",
      ]);

      yield* stack.destroy();

      const gone = yield* getDroplet({ droplet_id: created.dropletId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "droplet is recovered through its ownership tag after state loss",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(droplet(DROPLET_NAME, []));
      // A deleted state row hides the droplet from the harness teardown.
      yield* Effect.addFinalizer(() =>
        dropletsDestroy({ droplet_id: created.dropletId }).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          outOfBand,
          Effect.ignore,
        ),
      );

      const state = yield* yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "TestDroplet",
      });

      const recovered = yield* stack.deploy(droplet(DROPLET_NAME, []));
      expect(recovered.dropletId).toEqual(created.dropletId);
      expect(recovered.ipv4).toEqual(created.ipv4);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: LIVE_TIMEOUT },
);
