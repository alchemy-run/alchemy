import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetRadarValueListsValueList } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

// Aliases are unique per Stripe account, so every case owns a distinct,
// deterministic alias (no timestamps / randomness).
const MINIMAL_ALIAS = "alchemy_test_value_list_minimal";
const FULL_ALIAS = "alchemy_test_value_list_full";
const UPDATE_ALIAS = "alchemy_test_value_list_update";
const UPDATE_ALIAS_RENAMED = "alchemy_test_value_list_update_renamed";
const REPLACE_ALIAS = "alchemy_test_value_list_replace";
const LIST_ALIAS = "alchemy_test_value_list_listing";

const expectGone = Effect.fn(function* (valueListId: string) {
  const result = yield* Effect.result(
    GetRadarValueListsValueList({ value_list: valueListId }),
  );
  expect(Result.isFailure(result)).toBe(true);
});

test.provider("create and delete a value list with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const list = yield* stack.deploy(
      Stripe.RadarValueList("MinimalValueList", { alias: MINIMAL_ALIAS }),
    );

    expect(list.valueListId).toBeDefined();
    expect(list.alias).toEqual(MINIMAL_ALIAS);
    // `name` defaults to the alias.
    expect(list.name).toEqual(MINIMAL_ALIAS);
    expect(list.itemType).toEqual("string");
    expect(list.metadata).toEqual({});

    const fetched = yield* GetRadarValueListsValueList({
      value_list: list.valueListId,
    });
    expect(fetched.alias).toEqual(MINIMAL_ALIAS);
    expect(fetched.item_type).toEqual("string");
    // Alchemy brands ownership through metadata since Stripe has no tags.
    expect(fetched.metadata.alchemy_id).toEqual("MinimalValueList");
    expect(fetched.metadata.alchemy_stack).toBeDefined();
    expect(fetched.metadata.alchemy_stage).toBeDefined();

    yield* stack.destroy();

    yield* expectGone(list.valueListId);
  }),
);

test.provider("create a value list with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const list = yield* stack.deploy(
      Stripe.RadarValueList("FullValueList", {
        alias: FULL_ALIAS,
        name: "Alchemy full value list",
        itemType: "email",
        metadata: { team: "risk", owner: "fraud" },
      }),
    );

    expect(list.alias).toEqual(FULL_ALIAS);
    expect(list.name).toEqual("Alchemy full value list");
    expect(list.itemType).toEqual("email");
    // User-facing metadata never leaks alchemy's internal branding.
    expect(list.metadata).toEqual({ team: "risk", owner: "fraud" });
    expect(list.createdBy).toBeDefined();
    expect(list.created).toBeGreaterThan(0);

    const fetched = yield* GetRadarValueListsValueList({
      value_list: list.valueListId,
    });
    expect(fetched.name).toEqual("Alchemy full value list");
    expect(fetched.item_type).toEqual("email");
    expect(fetched.metadata.team).toEqual("risk");
    expect(fetched.metadata.owner).toEqual("fraud");

    yield* stack.destroy();

    yield* expectGone(list.valueListId);
  }),
);

test.provider("update alias, name and metadata in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.RadarValueList("UpdateValueList", {
        alias: UPDATE_ALIAS,
        name: "Before",
        itemType: "email",
        metadata: { team: "risk", owner: "fraud" },
      }),
    );

    expect(created.alias).toEqual(UPDATE_ALIAS);
    expect(created.name).toEqual("Before");

    const updated = yield* stack.deploy(
      Stripe.RadarValueList("UpdateValueList", {
        alias: UPDATE_ALIAS_RENAMED,
        name: "After",
        itemType: "email",
        metadata: { team: "trust" },
      }),
    );

    // Alias, name and metadata are all mutable — the id survives.
    expect(updated.valueListId).toEqual(created.valueListId);
    expect(updated.alias).toEqual(UPDATE_ALIAS_RENAMED);
    expect(updated.name).toEqual("After");
    expect(updated.metadata).toEqual({ team: "trust" });

    const fetched = yield* GetRadarValueListsValueList({
      value_list: updated.valueListId,
    });
    expect(fetched.alias).toEqual(UPDATE_ALIAS_RENAMED);
    expect(fetched.name).toEqual("After");
    expect(fetched.metadata.team).toEqual("trust");
    // A key the user removed is actually unset, not left behind.
    expect(fetched.metadata.owner).toBeUndefined();
    expect(fetched.metadata.alchemy_id).toEqual("UpdateValueList");

    yield* stack.destroy();

    yield* expectGone(updated.valueListId);
  }),
);

test.provider("replace the value list when itemType changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.RadarValueList("ReplaceValueList", {
        alias: REPLACE_ALIAS,
        itemType: "string",
      }),
    );
    expect(created.itemType).toEqual("string");

    const replaced = yield* stack.deploy(
      Stripe.RadarValueList("ReplaceValueList", {
        alias: REPLACE_ALIAS,
        itemType: "email",
      }),
    );

    // `item_type` is immutable in Stripe: the list is deleted and recreated
    // (delete-first, because the alias must stay unique).
    expect(replaced.valueListId).not.toEqual(created.valueListId);
    expect(replaced.itemType).toEqual("email");

    yield* expectGone(created.valueListId);

    const fetched = yield* GetRadarValueListsValueList({
      value_list: replaced.valueListId,
    });
    expect(fetched.item_type).toEqual("email");

    yield* stack.destroy();

    yield* expectGone(replaced.valueListId);
  }),
);

test.provider("list enumerates the deployed value list", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Stripe.RadarValueList("ListValueList", {
        alias: LIST_ALIAS,
        itemType: "ip_address",
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.RadarValueList);
    const all = yield* provider.list();

    const found = all.find((l) => l.valueListId === deployed.valueListId);
    expect(found).toBeDefined();
    expect(found?.alias).toEqual(LIST_ALIAS);
    expect(found?.itemType).toEqual("ip_address");

    yield* stack.destroy();

    yield* expectGone(deployed.valueListId);
  }),
);
