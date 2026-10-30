import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { hashOwnershipTag, isAlchemyTag } from "@alchemy.run/digitalocean/internal/ownership";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  deleteTag,
  dropletsDestroy,
  getDroplet,
  getTag,
  type Droplet as ApiDroplet,
} from "@distilled.cloud/digitalocean";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { KeyPair } from "alchemy/KeyPair";
import * as Output from "alchemy/Output";
import type * as Plan from "alchemy/Plan";
import { isResourceState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import { forgetAttributes, isGone, logLevel, skipLive, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

type DropletProps = DigitalOcean.DropletProps;
type DropletAttributes = DigitalOcean.DropletAttributes;

const DROPLET_TAG = "alchemy-test-droplet";
const EXTRA_DROPLET_TAG = "alchemy-test-droplet-extra";
const DROPLET_NAME = "alchemy-test-droplet";
const RENAMED_DROPLET_NAME = "alchemy-test-droplet-renamed";
const REPLACED_DROPLET_NAME = "alchemy-test-droplet-replaced";
const ORPHAN_DROPLET_NAME = "alchemy-test-droplet-orphan";
const REGION = "sfo2";
const OTHER_REGION = "nyc3";
// The smallest size, available in every region.
const SIZE = "s-1vcpu-512mb-10gb";
const OTHER_SIZE = "s-1vcpu-1gb";
const IMAGE = "ubuntu-24-04-x64";
const OTHER_IMAGE = "ubuntu-22-04-x64";
// Plans never send these, so they need not exist.
const SSH_KEY_FINGERPRINT = "3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa";
const VOLUME_ID = "506f78a4-e098-11e5-ad9f-000f53306ae1";
const VPC_UUID = "760e09ef-dc84-11e8-981e-3cfdfeaae000";
const CLOUD_CONFIG = "#cloud-config\npackages: [docker.io]";
// A droplet takes one to two minutes to create and as long to destroy.
const LIVE_TIMEOUT = 420_000;

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:droplet", "live"];

const PROPS: DropletProps = { region: REGION, size: SIZE, image: IMAGE };

const droplet = (props: Partial<DropletProps> = {}) =>
  DigitalOcean.Droplet("TestDroplet", { ...PROPS, ...props });

// The name comes from a key pair the plan has not created, so it is unknown.
const dropletWithUnresolvedName = (props: Partial<DropletProps>) =>
  Effect.gen(function* () {
    const pending = yield* KeyPair("PendingName");
    return yield* DigitalOcean.Droplet("TestDroplet", {
      ...PROPS,
      ...props,
      name: Output.map(pending.publicKey, () => DROPLET_NAME),
    });
  });

const DEPLOYED: Partial<DropletProps> = { name: DROPLET_NAME, tags: [DROPLET_TAG] };
const UPDATED: Partial<DropletProps> = {
  name: RENAMED_DROPLET_NAME,
  tags: [DROPLET_TAG, EXTRA_DROPLET_TAG],
  ipv6: true,
};

const NOOP = { action: "noop" };
const UPDATE = { action: "update" };
const REPLACE = { action: "replace", deleteFirst: false };
const REPLACE_DELETING_FIRST = { action: "replace", deleteFirst: true };

interface PlanCase {
  readonly change: string;
  /** Desired props, on top of the deployed ones. */
  readonly props?: Partial<DropletProps>;
  /** The persisted row, rewritten as if the cloud or the last deploy differed. */
  readonly persisted?: {
    readonly attr?: Partial<DropletAttributes>;
    readonly props?: Partial<DropletProps>;
  };
  readonly expected: object;
}

const PLAN_CASES: ReadonlyArray<PlanCase> = [
  { change: "nothing", expected: NOOP },
  { change: "region", props: { region: OTHER_REGION }, expected: REPLACE },
  { change: "size", props: { size: OTHER_SIZE }, expected: REPLACE },
  { change: "image", props: { image: OTHER_IMAGE }, expected: REPLACE },
  { change: "sshKeys", props: { sshKeys: [SSH_KEY_FINGERPRINT] }, expected: REPLACE },
  { change: "backups", props: { backups: true }, expected: REPLACE },
  { change: "monitoring", props: { monitoring: true }, expected: REPLACE },
  { change: "userData", props: { userData: CLOUD_CONFIG }, expected: REPLACE },
  { change: "volumes", props: { volumes: [VOLUME_ID] }, expected: REPLACE },
  { change: "vpcUuid", props: { vpcUuid: VPC_UUID }, expected: REPLACE },
  {
    change: "withDropletAgent set to false",
    props: { withDropletAgent: false },
    expected: REPLACE,
  },
  { change: "name", props: { name: RENAMED_DROPLET_NAME }, expected: UPDATE },
  { change: "tags", props: { tags: [DROPLET_TAG, EXTRA_DROPLET_TAG] }, expected: UPDATE },
  { change: "ipv6 enabled", props: { ipv6: true }, expected: UPDATE },
  {
    change: "replaceAfter longer than the droplet's age",
    props: { replaceAfter: "30 days" },
    expected: UPDATE,
  },
  {
    change: "replaceAfter shorter than the droplet's age",
    props: { replaceAfter: "1 second" },
    expected: REPLACE,
  },
  { change: "region drifted", persisted: { attr: { region: OTHER_REGION } }, expected: REPLACE },
  { change: "size drifted", persisted: { attr: { sizeSlug: OTHER_SIZE } }, expected: REPLACE },
  { change: "image drifted", persisted: { attr: { imageSlug: OTHER_IMAGE } }, expected: REPLACE },
  {
    change: "image slug unreported",
    persisted: { attr: { imageSlug: undefined } },
    expected: NOOP,
  },
  {
    change: "size of a droplet that holds volumes",
    props: { size: OTHER_SIZE, volumes: [VOLUME_ID] },
    persisted: { props: { volumes: [VOLUME_ID] } },
    expected: REPLACE_DELETING_FIRST,
  },
];

const plannedAction = (plan: Plan.Plan) => {
  const node = plan.resources.TestDroplet;
  return node?.action === "replace"
    ? { action: node.action, deleteFirst: node.deleteFirst }
    : { action: node?.action };
};

const dropletRow = (stack: Test.ScratchStack) => ({
  stack: stack.name,
  stage: stack.stage,
  fqn: "TestDroplet",
});

/** Runs `effect` while the persisted row is rewritten, then puts the row back. */
const withPersistedRow = <A, E, R>(
  stack: Test.ScratchStack,
  rewrite: NonNullable<PlanCase["persisted"]>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = dropletRow(stack);
    const deployed = yield* state.get(address);
    if (!isResourceState(deployed) || deployed.attr === undefined) {
      return yield* Effect.die(new Error("Expected a deployed TestDroplet row"));
    }
    const rewritten = {
      ...deployed,
      attr: { ...deployed.attr, ...rewrite.attr },
      props: { ...deployed.props, ...rewrite.props },
    };
    return yield* Effect.acquireUseRelease(
      state.set({ ...address, value: rewritten }),
      () => effect,
      () => Effect.asVoid(state.set({ ...address, value: deployed })),
    );
  });

const planDroplet = (stack: Test.ScratchStack, { props, persisted }: PlanCase) => {
  const plan = stack.plan(droplet({ ...DEPLOYED, ...props }));
  return persisted === undefined ? plan : withPersistedRow(stack, persisted, plan);
};

const isGenerationTag = (tag: string) => tag.startsWith("alchemy:generation:");

const generationTagOf = (dropletId: number) =>
  getDroplet({ droplet_id: dropletId }).pipe(
    Effect.flatMap((response) => Effect.fromNullishOr(response.droplet.tags.find(isGenerationTag))),
  );

/** Deletes the state row, as if the state store had lost it. */
const forgetStateRow = Effect.fn(function* (stack: Test.ScratchStack) {
  const state = yield* yield* State;
  yield* state.delete(dropletRow(stack));
});

/** Destroys a droplet the stack no longer knows about, and its alchemy tags. */
const destroyOrphan = (orphan: ApiDroplet) =>
  ignoreNotFound(dropletsDestroy({ droplet_id: orphan.id })).pipe(
    Effect.andThen(
      Effect.forEach(
        orphan.tags.filter(isAlchemyTag),
        (tag) => ignoreNotFound(deleteTag({ tag_id: tag })),
        { discard: true },
      ),
    ),
  );

test.provider.skipIf(skipLive)(
  "a tag with the reserved alchemy: prefix is refused before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const refused = yield* stack.deploy(droplet({ tags: ["alchemy:mine"] })).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(DigitalOcean.DropletTagReserved);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);

test.provider.skipIf(skipSlow)(
  "droplet lifecycle: create, plan each change, resume lost attributes, update in place, refuse a foreign twin, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(droplet(DEPLOYED));
      expect(created).toMatchObject({
        name: DROPLET_NAME,
        status: "active",
        region: REGION,
        sizeSlug: SIZE,
        tags: [DROPLET_TAG],
      });
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

      const remote = yield* getDroplet({ droplet_id: created.dropletId });
      const ownershipTag = yield* hashOwnershipTag(stack.name, stack.stage, "TestDroplet");
      const generationTag = yield* generationTagOf(created.dropletId);
      expect(remote.droplet.name).toEqual(DROPLET_NAME);
      expect([...remote.droplet.tags].sort()).toEqual(
        [DROPLET_TAG, ownershipTag, generationTag].sort(),
      );

      const planned = yield* Effect.forEach(PLAN_CASES, (planCase) =>
        planDroplet(stack, planCase).pipe(
          Effect.map((plan) => [planCase.change, plannedAction(plan)] as const),
        ),
      );
      expect(Object.fromEntries(planned)).toEqual(
        Object.fromEntries(PLAN_CASES.map(({ change, expected }) => [change, expected])),
      );

      // A name known only after deploy does not hide a change that replaces.
      const behindUnresolvedName = yield* stack.plan(
        dropletWithUnresolvedName({ ...DEPLOYED, userData: CLOUD_CONFIG }),
      );
      expect(plannedAction(behindUnresolvedName)).toEqual(REPLACE);

      yield* forgetAttributes(dropletRow(stack));
      const resumed = yield* stack.deploy(droplet(DEPLOYED));
      expect(resumed.dropletId).toEqual(created.dropletId);

      const updated = yield* stack.deploy(droplet(UPDATED));
      expect(updated).toMatchObject({
        dropletId: created.dropletId,
        name: RENAMED_DROPLET_NAME,
        ipv4: created.ipv4,
      });
      expect([...updated.tags].sort()).toEqual([DROPLET_TAG, EXTRA_DROPLET_TAG]);
      expect(updated.features).toContain("ipv6");
      expect(updated.ipv6).toMatch(/:/);
      expect(plannedAction(yield* stack.plan(droplet({ ...UPDATED, ipv6: false })))).toEqual(
        REPLACE,
      );

      // A same-named droplet without this resource's tag belongs to someone else.
      const twinFailure = yield* stack
        .plan(
          droplet(UPDATED).pipe(
            Effect.andThen(DigitalOcean.Droplet("Twin", { ...PROPS, name: RENAMED_DROPLET_NAME })),
          ),
        )
        .pipe(Effect.flip);
      expect(twinFailure).toBeInstanceOf(OwnedBySomeoneElse);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: ownershipTag }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: generationTag }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: DROPLET_TAG }))).toBe(false);
      yield* Effect.forEach(
        [DROPLET_TAG, EXTRA_DROPLET_TAG],
        (tag) => ignoreNotFound(deleteTag({ tag_id: tag })),
        { discard: true },
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "a replacement gets a new generation tag, and the old droplet and its tag are deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(droplet({ name: REPLACED_DROPLET_NAME }));
      const oldGenerationTag = yield* generationTagOf(created.dropletId);

      const replaced = yield* stack.deploy(
        droplet({ name: REPLACED_DROPLET_NAME, image: OTHER_IMAGE }),
      );
      expect(replaced.dropletId).not.toEqual(created.dropletId);
      expect(replaced.imageSlug).toEqual(OTHER_IMAGE);
      expect(replaced.name).toEqual(REPLACED_DROPLET_NAME);
      expect(yield* generationTagOf(replaced.dropletId)).not.toEqual(oldGenerationTag);
      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: oldGenerationTag }))).toBe(true);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: replaced.dropletId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "a droplet whose state row is lost is left alone and the next deploy creates a new one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const orphanDroplet = droplet({ name: ORPHAN_DROPLET_NAME });

      yield* Effect.acquireUseRelease(
        stack.deploy(orphanDroplet).pipe(
          Effect.flatMap((created) => getDroplet({ droplet_id: created.dropletId })),
          Effect.map((response) => response.droplet),
          Effect.tap(() => forgetStateRow(stack)),
        ),
        (orphan) =>
          Effect.gen(function* () {
            const recreated = yield* stack.deploy(orphanDroplet);
            expect(recreated.dropletId).not.toEqual(orphan.id);

            yield* stack.destroy();

            expect(yield* isGone(getDroplet({ droplet_id: recreated.dropletId }))).toBe(true);
            expect(yield* isGone(getDroplet({ droplet_id: orphan.id }))).toBe(false);
          }),
        // A deleted state row hides the droplet from the harness teardown.
        destroyOrphan,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
