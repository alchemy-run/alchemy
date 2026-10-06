import { dropletsDestroy, getDroplet, getTag } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import {
  diffDroplet,
  propsChangedSinceLastDeploy,
  propsDriftedFromCloud,
} from "@/DigitalOcean/Droplet";
import { hashOwnershipTag } from "@/DigitalOcean/ownership";
import * as Output from "@/Output";
import { State } from "@/State/State";
import * as Test from "@/Test/Alchemy";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

type DropletProps = DigitalOcean.DropletProps;
type DropletAttributes = DigitalOcean.DropletAttributes;

const DROPLET_TAG = "alchemy-test-droplet";
const EXTRA_DROPLET_TAG = "alchemy-test-droplet-extra";
const DROPLET_NAME = "alchemy-test-droplet";
const RENAMED_DROPLET_NAME = "alchemy-test-droplet-renamed";
// The smallest size that exists in every region. A live droplet costs
// money. Each live test creates one droplet and always destroys it.
const REGION = "sfo3";
const SIZE = "s-1vcpu-512mb-10gb";
const IMAGE = "ubuntu-24-04-x64";
const OTHER_IMAGE = "ubuntu-22-04-x64";
// A droplet takes one to two minutes to create and as long to destroy.
const LIVE_TIMEOUT = 240_000;

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

const REPLACE = { action: "replace", deleteFirst: false };
const REPLACE_DELETING_FIRST = { action: "replace", deleteFirst: true };

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

  it.effect("replaceAfter replaces a droplet exactly as old as the limit", () =>
    Effect.gen(function* () {
      const props = { ...PROPS, replaceAfter: "30 days" as const };
      const result = yield* diff({
        olds: { ...props },
        news: props,
        output: observed({ createdAt: daysAgo(30) }),
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

  it.effect("a region that drifted on the cloud replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS },
        output: observed({ region: "nyc3" }),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  it.effect("a size that drifted on the cloud replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS },
        output: observed({ sizeSlug: "s-2vcpu-4gb" }),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  it.effect("a droplet that matches its props is kept", () =>
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
        olds: { ...PROPS, monitoring: false },
        news: { ...PROPS, monitoring: undefined },
        output: observed(),
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("enabling ipv6 is left to the in-place update", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, ipv6: false },
        news: { ...PROPS, ipv6: true },
        output: observed(),
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("disabling ipv6 replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, ipv6: true },
        news: { ...PROPS, ipv6: false },
        output: observed({ features: ["ipv6"] }),
      });
      expect(result).toEqual(REPLACE);
    }),
  );

  it.effect("turning backups on replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS },
        news: { ...PROPS, backups: true },
        output: observed(),
      });
      expect(result).toEqual(REPLACE);
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

  it.effect("a droplet with volumes is deleted before its replacement", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { ...PROPS, volumes: ["volume-1"] },
        news: { ...PROPS, size: "s-2vcpu-4gb", volumes: ["volume-1"] },
        output: observed(),
      });
      expect(result).toEqual(REPLACE_DELETING_FIRST);
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

  it.effect(
    "an ssh key known only after deploy does not replace a droplet that does not exist yet",
    () =>
      Effect.gen(function* () {
        const result = yield* diff({
          olds: { ...PROPS },
          news: { ...PROPS, sshKeys: [Output.literal("cc:dd")] },
          output: undefined,
        });
        expect(result).toBeUndefined();
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
      name: "feature flags are not compared with the lagging features list",
      news: { ...PROPS, backups: true },
      droplet: observed({ features: ["ipv6", "monitoring"] }),
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
      name: "backups turned on",
      olds: PROPS,
      news: { ...PROPS, backups: true },
      expected: ["backups"],
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
      name: "monitoring omitted instead of false",
      olds: { ...PROPS, monitoring: false },
      news: PROPS,
      expected: [],
    },
    {
      name: "monitoring turned on",
      olds: PROPS,
      news: { ...PROPS, monitoring: true },
      expected: ["monitoring"],
    },
    {
      name: "ipv6 turned on",
      olds: PROPS,
      news: { ...PROPS, ipv6: true },
      expected: [],
    },
    {
      name: "ipv6 turned off",
      olds: { ...PROPS, ipv6: true },
      news: PROPS,
      expected: ["ipv6"],
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

const droplet = (props: Partial<DropletProps>) =>
  DigitalOcean.Droplet("TestDroplet", { ...PROPS, ...props });

const isGenerationTag = (tag: string) => tag.startsWith("alchemy:generation:");

const generationTagOf = (dropletId: number) =>
  getDroplet({ droplet_id: dropletId }).pipe(
    Effect.map((response) => response.droplet.tags.find(isGenerationTag)),
  );

test.provider.skipIf(skipSlow)(
  "droplet lifecycle: create, update name, tags and ipv6 in place, refuse foreign and reserved names, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(droplet({ name: DROPLET_NAME, tags: [DROPLET_TAG] }));
      expect(created.name).toEqual(DROPLET_NAME);
      expect(created.status).toEqual("active");
      expect(created.region).toEqual(REGION);
      expect(created.sizeSlug).toEqual(SIZE);
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.tags).toEqual([DROPLET_TAG]);

      const remote = yield* getDroplet({ droplet_id: created.dropletId });
      expect(remote.droplet.name).toEqual(DROPLET_NAME);
      const ownershipTag = yield* hashOwnershipTag(stack.name, stack.stage, "TestDroplet");
      const generationTag = remote.droplet.tags.find(isGenerationTag);
      expect(remote.droplet.tags).toHaveLength(3);
      expect(remote.droplet.tags).toContain(DROPLET_TAG);
      expect(remote.droplet.tags).toContain(ownershipTag);
      expect(generationTag).toBeDefined();

      const updated = yield* stack.deploy(
        droplet({ name: RENAMED_DROPLET_NAME, tags: [DROPLET_TAG, EXTRA_DROPLET_TAG], ipv6: true }),
      );
      expect(updated.dropletId).toEqual(created.dropletId);
      expect(updated.name).toEqual(RENAMED_DROPLET_NAME);
      expect(updated.ipv4).toEqual(created.ipv4);
      expect([...updated.tags].sort()).toEqual([DROPLET_TAG, EXTRA_DROPLET_TAG]);
      expect(updated.features).toContain("ipv6");
      expect(updated.ipv6).toMatch(/:/);

      // A same-named droplet without this resource's tag belongs to someone else.
      const foreign = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* droplet({
              name: RENAMED_DROPLET_NAME,
              tags: [DROPLET_TAG, EXTRA_DROPLET_TAG],
              ipv6: true,
            });
            return yield* DigitalOcean.Droplet("Twin", { ...PROPS, name: RENAMED_DROPLET_NAME });
          }),
        )
        .pipe(Effect.flip);
      expect(foreign).toBeInstanceOf(OwnedBySomeoneElse);

      const reserved = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* droplet({
              name: RENAMED_DROPLET_NAME,
              tags: [DROPLET_TAG, EXTRA_DROPLET_TAG],
              ipv6: true,
            });
            return yield* DigitalOcean.Droplet("Reserved", { ...PROPS, tags: ["alchemy:mine"] });
          }),
        )
        .pipe(Effect.flip);
      expect(reserved).toBeInstanceOf(DigitalOcean.DropletTagReserved);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
      // The user tags stay; the alchemy tags go with their last droplet.
      expect(yield* isGone(getTag({ tag_id: ownershipTag }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: generationTag ?? "" }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "a new image replaces the droplet: the replacement is created before the old one is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(droplet({ name: DROPLET_NAME }));
      const oldGenerationTag = yield* generationTagOf(created.dropletId);

      const replaced = yield* stack.deploy(droplet({ name: DROPLET_NAME, image: OTHER_IMAGE }));
      expect(replaced.dropletId).not.toEqual(created.dropletId);
      expect(replaced.imageSlug).toEqual(OTHER_IMAGE);
      expect(replaced.name).toEqual(DROPLET_NAME);
      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: oldGenerationTag ?? "" }))).toBe(true);
      expect(yield* generationTagOf(replaced.dropletId)).not.toEqual(oldGenerationTag);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: replaced.dropletId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "droplet is recovered through its ownership tag after state loss",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(droplet({ name: DROPLET_NAME }));
      // A deleted state row hides the droplet from the harness teardown.
      yield* Effect.addFinalizer(() =>
        dropletsDestroy({ droplet_id: created.dropletId }).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Droplet ${created.dropletId} was not cleaned up`, cause),
          ),
        ),
      );

      const state = yield* yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: stack.stage,
        fqn: "TestDroplet",
      });

      const recovered = yield* stack.deploy(droplet({ name: DROPLET_NAME }));
      expect(recovered.dropletId).toEqual(created.dropletId);
      expect(recovered.ipv4).toEqual(created.ipv4);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
