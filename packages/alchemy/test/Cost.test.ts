import { planProp } from "@/Cost";
import type { Input } from "@/Input";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

interface Props {
  name?: string;
  tags?: string[];
}

describe("planProp", () => {
  test("a plain resolved prop comes back as-is", () => {
    const props: Input<Props> = { name: "a" };
    expect(planProp(props, "name")).toEqual({ value: "a", unresolved: false });
  });

  test("absent props and absent keys are absent, not unresolved", () => {
    expect(planProp<Props, "name">(undefined, "name")).toEqual({
      value: undefined,
      unresolved: false,
    });
    const props: Input<Props> = {};
    expect(planProp(props, "name")).toEqual({
      value: undefined,
      unresolved: false,
    });
  });

  test("an Output prop is unresolved", () => {
    const props: Input<Props> = { name: asOutput("a") };
    expect(planProp(props, "name")).toEqual({
      value: undefined,
      unresolved: true,
    });
  });

  test("an Effect prop is unresolved", () => {
    const props: Input<Props> = { name: Effect.succeed("a") };
    expect(planProp(props, "name")).toEqual({
      value: undefined,
      unresolved: true,
    });
  });

  test("a whole-props Output makes every prop unresolved", () => {
    const props: Input<Props> = asOutput({ name: "a" });
    expect(planProp(props, "name")).toEqual({
      value: undefined,
      unresolved: true,
    });
  });

  test("an Output nested inside a structured prop is unresolved", () => {
    const props: Input<Props> = { tags: ["a", asOutput("b")] };
    expect(planProp(props, "tags")).toEqual({
      value: undefined,
      unresolved: true,
    });
  });
});
