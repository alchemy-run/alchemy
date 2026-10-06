import { dropletsDestroy, getDroplet } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as DigitalOcean from "@/DigitalOcean";
import {
  diffDroplet,
  propsChangedSinceLastDeploy,
  propsDriftedFromCloud,
} from "@/DigitalOcean/Droplets/Droplet";
import { generationTagFor, hashOwnershipTag } from "@/DigitalOcean/ownership";
import type { Input } from "@/Input";
import * as Output from "@/Output";
import { State } from "@/State/State";
import * as Test from "@/Test/Alchemy";
import { isGone, logLevel, outOfBand, skipLive } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

type DropletProps = DigitalOcean.DropletProps;
type DropletAttributes = DigitalOcean.DropletAttributes;

const DROPLET_TAG = "alchemy-test-droplet";
const EXTRA_DROPLET_TAG = "alchemy-test-droplet-extra";
const DROPLET_NAME = "alchemy-test-droplet";
const RENAMED_DROPLET_NAME = "alchemy-test-droplet-renamed";
// The smallest size that exists in every region. A live droplet costs
// money. The suite creates one droplet and always destroys it.
const REGION = "sfo3";
const SIZE = "s-1vcpu-512mb-10gb";
const IMAGE = "ubuntu-24-04-x64";
// A droplet takes one to two minutes to create and as long to destroy.
const LIVE_TIMEOUT = 480_000;

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:droplet", "local"];
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:droplet", "live"];

const PROPS: DropletProps = { region: REGION, size: SIZE, image: IMAGE };

const NOW = Date.parse("2026-06-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const observed = (overrides: Partial<DropletAttributes> = {}): DropletAttributes => ({
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

const diff = (input: Parameters<typeof diffDroplet>[0]) =>
  TestClock.setTime(NOW).pipe(Effect.andThen(diffDroplet(input)));

const REPLACE = { action: "replace", deleteFirst: true };

describe("Droplet diff", { tags: UNIT_TAGS }, () => {
  it.effect("replaceAfter replaces a droplet older than the limit", () =>
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

  it.effect("replaceAfter keeps a droplet younger than the limit", () =>
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

  it.effect("replaceAfter ignores an unreadable createdAt", () =>
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

  it.effect("replaceAfter does not apply without prior props", () =>
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

  it.effect("adoption replaces when create-time props differ from the droplet", () =>
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

  it.effect("a copy of the prior props still sees observed drift", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS },
        output: observed({ sizeSlug: "s-2vcpu-4gb" }),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  it.effect("adoption keeps a droplet that matches its props", () =>
    Effect.gen(function* () {
      const news = { ...PROPS, image: 100 };
      const result = yield* diff({ olds: news, news, output: observed() });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("a droplet without an image slug does not drift", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS },
        output: observed({ imageSlug: undefined }),
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("clearing withDropletAgent replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, withDropletAgent: undefined },
        news: { ...PROPS, withDropletAgent: false },
        output: observed(),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  it.effect("omitting a defaulted boolean is not a change", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, backups: false },
        news: { ...PROPS, backups: undefined },
        output: observed(),
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("name and tags are left to the engine's update", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, name: "a", tags: ["x"] },
        news: { ...PROPS, name: "b", tags: ["x", "y"] },
        output: observed(),
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("an ssh key known only after deploy replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, sshKeys: ["aa:bb"] },
        news: { ...PROPS, sshKeys: [Output.literal("cc:dd")] },
        output: observed(),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  it.effect("a name known only after deploy does not replace", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, name: "a" },
        news: { ...PROPS, name: Output.literal("b") },
        output: observed(),
      });
      expect(result).toBeUndefined();
    }),
  );
});

describe("propsDriftedFromCloud", { tags: UNIT_TAGS }, () => {
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
      expect(propsDriftedFromCloud(testCase.news, testCase.droplet)).toEqual(testCase.expected);
    });
  }
});

describe("propsChangedSinceLastDeploy", { tags: UNIT_TAGS }, () => {
  const cases: Array<{
    name: string;
    olds: DropletProps;
    news: DropletProps;
    expected: string[];
  }> = [
    { name: "same props", olds: PROPS, news: { ...PROPS }, expected: [] },
    {
      name: "name, tags and replaceAfter change in place",
      olds: { ...PROPS, name: "a", tags: ["x"] },
      news: { ...PROPS, name: "b", tags: ["y"], replaceAfter: "30 days" },
      expected: [],
    },
    {
      name: "user data differs",
      olds: { ...PROPS, userData: "#cloud-config\na" },
      news: { ...PROPS, userData: "#cloud-config\nb" },
      expected: ["userData"],
    },
    {
      name: "ssh keys in another order",
      olds: { ...PROPS, sshKeys: ["aa:bb", 7] },
      news: { ...PROPS, sshKeys: [7, "aa:bb"] },
      expected: [],
    },
    {
      name: "an ssh key is swapped",
      olds: { ...PROPS, sshKeys: ["aa:bb"] },
      news: { ...PROPS, sshKeys: ["cc:dd"] },
      expected: ["sshKeys"],
    },
    {
      name: "a volume is added",
      olds: PROPS,
      news: { ...PROPS, volumes: ["volume-1"] },
      expected: ["volumes"],
    },
    {
      name: "a feature flag omitted instead of false",
      olds: { ...PROPS, monitoring: false },
      news: PROPS,
      expected: [],
    },
    {
      name: "a feature flag turned on",
      olds: PROPS,
      news: { ...PROPS, monitoring: true },
      expected: ["monitoring"],
    },
    {
      name: "the droplet agent omitted instead of false",
      olds: { ...PROPS, withDropletAgent: false },
      news: PROPS,
      expected: ["withDropletAgent"],
    },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(propsChangedSinceLastDeploy(testCase.news, testCase.olds)).toEqual(testCase.expected);
    });
  }
});

describe("ownership tags", { tags: UNIT_TAGS }, () => {
  it.effect("is stable and fits DigitalOcean's tag rules", () =>
    Effect.gen(function* () {
      const tag = yield* hashOwnershipTag("stack", "stage", "id");
      expect(tag).toEqual(yield* hashOwnershipTag("stack", "stage", "id"));
      expect(tag.startsWith("alchemy:")).toBe(true);
      expect(tag).toMatch(/^[a-zA-Z0-9:_-]+$/);
      expect(tag.length).toBeLessThanOrEqual(255);
    }),
  );

  it.effect("does not collide on names that differ only in punctuation", () =>
    Effect.gen(function* () {
      expect(yield* hashOwnershipTag("api.prod", "s", "id")).not.toEqual(
        yield* hashOwnershipTag("api-prod", "s", "id"),
      );
    }),
  );

  it.effect("does not collide when the tuple boundaries move", () =>
    Effect.gen(function* () {
      expect(yield* hashOwnershipTag("a:b", "c", "id")).not.toEqual(
        yield* hashOwnershipTag("a", "b:c", "id"),
      );
    }),
  );

  it.effect("tells a nested resource from a top-level one", () =>
    Effect.gen(function* () {
      expect(yield* hashOwnershipTag("stack", "stage", "Api/Host")).not.toEqual(
        yield* hashOwnershipTag("stack", "stage", "Host"),
      );
    }),
  );

  it("tells two generations of one resource apart", () => {
    expect(generationTagFor("a".repeat(32))).not.toEqual(generationTagFor("b".repeat(32)));
    expect(generationTagFor("a".repeat(32))).toMatch(/^[a-zA-Z0-9:_-]+$/);
  });
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

      const created = yield* stack.deploy(droplet(DROPLET_NAME, [DROPLET_TAG]));
      expect(created.name).toEqual(DROPLET_NAME);
      expect(created.status).toEqual("active");
      expect(created.region).toEqual(REGION);
      expect(created.sizeSlug).toEqual(SIZE);
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.tags).toEqual([DROPLET_TAG]);

      const remote = yield* getDroplet({ droplet_id: created.dropletId }).pipe(outOfBand);
      expect(remote.droplet.name).toEqual(DROPLET_NAME);
      const ownershipTag = yield* hashOwnershipTag(stack.name, stack.stage, "TestDroplet");
      expect(remote.droplet.tags).toHaveLength(3);
      expect(remote.droplet.tags).toContain(DROPLET_TAG);
      expect(remote.droplet.tags).toContain(ownershipTag);
      expect(remote.droplet.tags.some((tag) => tag.startsWith(generationTagFor("")))).toBe(true);

      const renamed = yield* stack.deploy(
        droplet(RENAMED_DROPLET_NAME, [DROPLET_TAG, EXTRA_DROPLET_TAG]),
      );
      expect(renamed.dropletId).toEqual(created.dropletId);
      expect(renamed.name).toEqual(RENAMED_DROPLET_NAME);
      expect(renamed.ipv4).toEqual(created.ipv4);
      expect([...renamed.tags].sort()).toEqual([DROPLET_TAG, EXTRA_DROPLET_TAG]);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
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
        stage: stack.stage,
        fqn: "TestDroplet",
      });

      const recovered = yield* stack.deploy(droplet(DROPLET_NAME, []));
      expect(recovered.dropletId).toEqual(created.dropletId);
      expect(recovered.ipv4).toEqual(created.ipv4);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
