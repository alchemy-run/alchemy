import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetRadarValueListItemsItem } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

// Value list aliases are unique per Stripe account, so every case owns a
// distinct, deterministic alias for its parent list.
const BASIC_ALIAS = "alchemy_test_vli_basic";
const IDEMPOTENT_ALIAS = "alchemy_test_vli_idempotent";
const VALUE_CHANGE_ALIAS = "alchemy_test_vli_value_change";
const MOVE_LIST_A_ALIAS = "alchemy_test_vli_move_a";
const MOVE_LIST_B_ALIAS = "alchemy_test_vli_move_b";
const LIST_ALIAS = "alchemy_test_vli_listing";

const expectGone = Effect.fn(function* (valueListItemId: string) {
  const result = yield* Effect.result(
    GetRadarValueListItemsItem({ item: valueListItemId }),
  );
  expect(Result.isFailure(result)).toBe(true);
});

test.provider("create and delete a value list item", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { list, item } = yield* stack.deploy(
      Effect.gen(function* () {
        const list = yield* Stripe.RadarValueList("BasicItemList", {
          alias: BASIC_ALIAS,
          itemType: "email",
        });
        const item = yield* Stripe.RadarValueListItem("BasicItem", {
          valueListId: list.valueListId,
          value: "fraud@example.com",
        });
        return { list, item };
      }),
    );

    expect(item.valueListItemId).toBeDefined();
    expect(item.valueListId).toEqual(list.valueListId);
    expect(item.value).toEqual("fraud@example.com");
    expect(item.createdBy).toBeDefined();
    expect(item.created).toBeGreaterThan(0);

    const fetched = yield* GetRadarValueListItemsItem({
      item: item.valueListItemId,
    });
    expect(fetched.value).toEqual("fraud@example.com");
    expect(fetched.value_list).toEqual(list.valueListId);

    yield* stack.destroy();

    yield* expectGone(item.valueListItemId);
  }),
);

test.provider("redeploying an unchanged item preserves its id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Effect.gen(function* () {
        const list = yield* Stripe.RadarValueList("IdempotentItemList", {
          alias: IDEMPOTENT_ALIAS,
          itemType: "email",
        });
        const item = yield* Stripe.RadarValueListItem("IdempotentItem", {
          valueListId: list.valueListId,
          value: "stable@example.com",
        });
        return { list, item };
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.item.valueListItemId).toEqual(created.item.valueListItemId);
    expect(again.item.value).toEqual("stable@example.com");
    expect(again.list.valueListId).toEqual(created.list.valueListId);

    yield* stack.destroy();

    yield* expectGone(created.item.valueListItemId);
  }),
);

test.provider("replace the item when its value changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const list = yield* Stripe.RadarValueList("ValueChangeList", {
          alias: VALUE_CHANGE_ALIAS,
          itemType: "email",
        });
        const item = yield* Stripe.RadarValueListItem("ValueChangeItem", {
          valueListId: list.valueListId,
          value: "before@example.com",
        });
        return { list, item };
      }),
    );

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const list = yield* Stripe.RadarValueList("ValueChangeList", {
          alias: VALUE_CHANGE_ALIAS,
          itemType: "email",
        });
        const item = yield* Stripe.RadarValueListItem("ValueChangeItem", {
          valueListId: list.valueListId,
          value: "after@example.com",
        });
        return { list, item };
      }),
    );

    // Items are immutable — Stripe exposes no update endpoint — so a new
    // value replaces the item.
    expect(replaced.list.valueListId).toEqual(created.list.valueListId);
    expect(replaced.item.valueListItemId).not.toEqual(
      created.item.valueListItemId,
    );
    expect(replaced.item.value).toEqual("after@example.com");

    yield* expectGone(created.item.valueListItemId);

    const fetched = yield* GetRadarValueListItemsItem({
      item: replaced.item.valueListItemId,
    });
    expect(fetched.value).toEqual("after@example.com");

    yield* stack.destroy();

    yield* expectGone(replaced.item.valueListItemId);
  }),
);

test.provider("replace the item when its parent list changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Both lists stay deployed across the change so only the item is
    // replaced — the parent it moves to already exists.
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const listA = yield* Stripe.RadarValueList("MoveListA", {
          alias: MOVE_LIST_A_ALIAS,
          itemType: "email",
        });
        const listB = yield* Stripe.RadarValueList("MoveListB", {
          alias: MOVE_LIST_B_ALIAS,
          itemType: "email",
        });
        const item = yield* Stripe.RadarValueListItem("MoveItem", {
          valueListId: listA.valueListId,
          value: "moved@example.com",
        });
        return { listA, listB, item };
      }),
    );

    const moved = yield* stack.deploy(
      Effect.gen(function* () {
        const listA = yield* Stripe.RadarValueList("MoveListA", {
          alias: MOVE_LIST_A_ALIAS,
          itemType: "email",
        });
        const listB = yield* Stripe.RadarValueList("MoveListB", {
          alias: MOVE_LIST_B_ALIAS,
          itemType: "email",
        });
        const item = yield* Stripe.RadarValueListItem("MoveItem", {
          valueListId: listB.valueListId,
          value: "moved@example.com",
        });
        return { listA, listB, item };
      }),
    );

    expect(moved.item.valueListItemId).not.toEqual(
      created.item.valueListItemId,
    );
    expect(moved.item.valueListId).toEqual(created.listB.valueListId);

    yield* expectGone(created.item.valueListItemId);

    const fetched = yield* GetRadarValueListItemsItem({
      item: moved.item.valueListItemId,
    });
    expect(fetched.value_list).toEqual(created.listB.valueListId);

    yield* stack.destroy();

    yield* expectGone(moved.item.valueListItemId);
  }),
);

test.provider("list enumerates the deployed value list item", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { item } = yield* stack.deploy(
      Effect.gen(function* () {
        const list = yield* Stripe.RadarValueList("ListItemList", {
          alias: LIST_ALIAS,
          itemType: "ip_address",
        });
        const item = yield* Stripe.RadarValueListItem("ListItem", {
          valueListId: list.valueListId,
          value: "203.0.113.7",
        });
        return { list, item };
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.RadarValueListItem);
    const all = yield* provider.list();

    const found = all.find((i) => i.valueListItemId === item.valueListItemId);
    expect(found).toBeDefined();
    expect(found?.value).toEqual("203.0.113.7");
    expect(found?.valueListId).toEqual(item.valueListId);

    yield* stack.destroy();

    yield* expectGone(item.valueListItemId);
  }),
);
