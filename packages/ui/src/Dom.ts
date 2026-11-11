/**
 * Renders a view into the DOM, once. Static parts become plain nodes; every
 * signal gets a subscriber that writes the one text node, attribute or
 * property it fills. Event attributes send Intents.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type * as Component from "./Component.ts";
import { isNode, type Child } from "./html.ts";
import { fire, isTrigger } from "./Intent.ts";
import { subscribe } from "./internal/graph.ts";
import { isSignal, sourceOf } from "./Signal.ts";

/** Properties set on the element rather than as attributes, so they track user edits. */
const properties = new Set(["value", "checked"]);

const renderChild = (child: Child, parent: globalThis.Node, dispose: Array<() => void>): void => {
  const document = parent.ownerDocument ?? (parent as Document);
  if (child === null || child === undefined || typeof child === "boolean") return;
  if (typeof child === "string" || typeof child === "number") {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  if (Array.isArray(child)) {
    for (const c of child) renderChild(c, parent, dispose);
    return;
  }
  if (isSignal(child)) {
    const text = document.createTextNode("");
    dispose.push(
      subscribe(sourceOf(child), (value) => {
        text.data = String(value);
      }),
    );
    parent.appendChild(text);
    return;
  }
  if (isNode(child)) {
    const el = document.createElement(child.tag);
    for (const [key, value] of Object.entries(child.attrs)) {
      if (value === undefined) continue;
      if (key.startsWith("on") && isTrigger(value)) {
        const listener = (event: Event) => fire(value, event);
        const type = key.slice(2).toLowerCase();
        el.addEventListener(type, listener);
        dispose.push(() => el.removeEventListener(type, listener));
        continue;
      }
      const apply = (v: unknown) => setAttr(el, key, v);
      if (isSignal(value)) dispose.push(subscribe(sourceOf(value), apply));
      else apply(value);
    }
    for (const c of child.children) renderChild(c, el, dispose);
    parent.appendChild(el);
  }
};

const setAttr = (el: HTMLElement, key: string, value: unknown): void => {
  if (properties.has(key)) {
    (el as unknown as Record<string, unknown>)[key] = value;
  } else if (typeof value === "boolean") {
    el.toggleAttribute(key, value);
  } else if (value === null || value === undefined) {
    el.removeAttribute(key);
  } else {
    el.setAttribute(key, String(value));
  }
};

/**
 * Creates the component and renders it into `container`. Closing the scope
 * unmounts it: subscriptions, listeners and running handlers stop, and the
 * DOM it added is removed.
 */
export const render = <Self, P>(
  component: Component.Key<Self, P>,
  container: globalThis.Element,
  ...props: P extends void ? [props?: P] : [props: P]
): Effect.Effect<void, never, Self | Scope.Scope> =>
  Effect.gen(function* () {
    const factory = yield* component;
    const { view } = yield* factory.create(props[0] as P);
    const dispose: Array<() => void> = [];
    const fragment = container.ownerDocument.createDocumentFragment();
    renderChild(view, fragment, dispose);
    const added = [...fragment.childNodes];
    container.appendChild(fragment);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const d of dispose) d();
        for (const node of added) node.parentNode?.removeChild(node);
      }),
    );
  });

/** Renders the component into the element `selector` names and keeps it mounted until interrupted. */
export const mount = <Self, P>(
  component: Component.Key<Self, P>,
  selector: string,
  ...props: P extends void ? [props?: P] : [props: P]
): Effect.Effect<never, ContainerNotFound, Self> =>
  Effect.scoped(
    Effect.gen(function* () {
      const container = document.querySelector(selector);
      if (container === null) return yield* new ContainerNotFound({ selector });
      yield* render(component, container, ...props);
      return yield* Effect.never;
    }),
  );

export class ContainerNotFound extends Data.TaggedError("ContainerNotFound")<{
  readonly selector: string;
}> {
  override get message() {
    return `No element matches "${this.selector}".`;
  }
}
