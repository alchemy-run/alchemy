/**
 * Builders for the view. A view is a plain description: elements, text, and
 * signals in the places that change. The renderer creates the DOM once and
 * subscribes each signal to the one node or attribute it fills.
 *
 * ```typescript
 * html.div(
 *   html.h1("Hello, world"),
 *   html.p(Signal.map(clicks, (n) => `Clicked ${n} times`)),
 *   html.button({ onClick: clicked, disabled: Signal.map(clicks, (n) => n >= 10) }, "Click me"),
 * );
 * ```
 */
import type { Intent, Trigger } from "./Intent.ts";
import { isSignal, type Signal } from "./Signal.ts";

export const NodeTypeId = "~@alchemy.run/ui/Node";

export interface Element {
  readonly [NodeTypeId]: "Element";
  readonly tag: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<Child>;
}

export type Node = Element;

/** Anything that can sit inside an element. `null`, `undefined` and booleans render nothing. */
export type Child =
  | string
  | number
  | boolean
  | null
  | undefined
  | Signal<string | number>
  | Node
  | ReadonlyArray<Child>;

/** A plain value, or a signal of one. */
export type Value<A> = A | Signal<A>;

type On<El, Ev> = Trigger<Ev & { readonly currentTarget: El }> | Intent<string, void>;

export interface Attrs<El> {
  readonly id?: Value<string>;
  readonly class?: Value<string>;
  readonly style?: Value<string>;
  readonly title?: Value<string>;
  readonly role?: Value<string>;
  readonly hidden?: Value<boolean>;
  readonly onClick?: On<El, MouseEvent>;
  readonly onDblClick?: On<El, MouseEvent>;
  readonly onInput?: On<El, InputEvent>;
  readonly onChange?: On<El, Event>;
  readonly onSubmit?: On<El, SubmitEvent>;
  readonly onKeyDown?: On<El, KeyboardEvent>;
  readonly onKeyUp?: On<El, KeyboardEvent>;
  readonly onFocus?: On<El, FocusEvent>;
  readonly onBlur?: On<El, FocusEvent>;
  readonly onPointerDown?: On<El, PointerEvent>;
  readonly onPointerMove?: On<El, PointerEvent>;
  readonly onPointerUp?: On<El, PointerEvent>;
}

export interface InputAttrs extends Attrs<HTMLInputElement> {
  readonly type?: string;
  readonly name?: string;
  readonly value?: Value<string>;
  readonly checked?: Value<boolean>;
  readonly placeholder?: Value<string>;
  readonly disabled?: Value<boolean>;
}

export interface ButtonAttrs extends Attrs<HTMLButtonElement> {
  readonly type?: "button" | "submit" | "reset";
  readonly disabled?: Value<boolean>;
}

export interface AnchorAttrs extends Attrs<HTMLAnchorElement> {
  readonly href?: Value<string>;
  readonly target?: string;
}

export interface LabelAttrs extends Attrs<HTMLLabelElement> {
  readonly for?: string;
}

export interface TextAreaAttrs extends Attrs<HTMLTextAreaElement> {
  readonly name?: string;
  readonly value?: Value<string>;
  readonly placeholder?: Value<string>;
  readonly disabled?: Value<boolean>;
}

export interface Builder<A> {
  (attrs: A, ...children: ReadonlyArray<Child>): Element;
  (...children: ReadonlyArray<Child>): Element;
}

export const isNode = (u: unknown): u is Node =>
  typeof u === "object" && u !== null && NodeTypeId in u;

const isAttrs = (u: unknown): boolean =>
  typeof u === "object" && u !== null && !Array.isArray(u) && !isNode(u) && !isSignal(u);

const element =
  <A>(tag: string): Builder<A> =>
  (...args: ReadonlyArray<unknown>): Element => {
    const [first, ...rest] = args;
    const hasAttrs = isAttrs(first);
    return {
      [NodeTypeId]: "Element",
      tag,
      attrs: hasAttrs ? (first as Record<string, unknown>) : {},
      children: (hasAttrs ? rest : args) as ReadonlyArray<Child>,
    };
  };

export const div = element<Attrs<HTMLDivElement>>("div");
export const span = element<Attrs<HTMLSpanElement>>("span");
export const p = element<Attrs<HTMLParagraphElement>>("p");
export const h1 = element<Attrs<HTMLHeadingElement>>("h1");
export const h2 = element<Attrs<HTMLHeadingElement>>("h2");
export const h3 = element<Attrs<HTMLHeadingElement>>("h3");
export const section = element<Attrs<HTMLElement>>("section");
export const header = element<Attrs<HTMLElement>>("header");
export const main = element<Attrs<HTMLElement>>("main");
export const footer = element<Attrs<HTMLElement>>("footer");
export const nav = element<Attrs<HTMLElement>>("nav");
export const strong = element<Attrs<HTMLElement>>("strong");
export const em = element<Attrs<HTMLElement>>("em");
export const small = element<Attrs<HTMLElement>>("small");
export const ul = element<Attrs<HTMLUListElement>>("ul");
export const ol = element<Attrs<HTMLOListElement>>("ol");
export const li = element<Attrs<HTMLLIElement>>("li");
export const form = element<Attrs<HTMLFormElement>>("form");
export const button = element<ButtonAttrs>("button");
export const input = element<InputAttrs>("input");
export const textarea = element<TextAreaAttrs>("textarea");
export const label = element<LabelAttrs>("label");
export const a = element<AnchorAttrs>("a");
