/**
 * One mounted component: its named state, its Intents, and the log of every
 * Intent it received and every write it made. The DOM and stories both reach a
 * component only through `dispatch`, so the log is complete.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { StateNode } from "./graph.ts";

export type LogEntry =
  | { readonly _tag: "Intent"; readonly name: string; readonly payload: unknown }
  | {
      readonly _tag: "Write";
      readonly name: string;
      readonly before: unknown;
      readonly after: unknown;
    }
  | { readonly _tag: "Died"; readonly intent: string; readonly cause: Cause.Cause<unknown> };

export class DuplicateName extends Data.TaggedError("DuplicateName")<{
  readonly component: string;
  readonly kind: "state" | "intent";
  readonly name: string;
}> {
  override get message() {
    return `${this.component} declares the ${this.kind} "${this.name}" twice. Names must be unique within a component.`;
  }
}

export class Instance {
  readonly states = new Map<string, StateNode<unknown>>();
  readonly intents = new Map<string, (payload: unknown) => Effect.Effect<void, never, Handler>>();
  readonly log: Array<LogEntry> = [];
  readonly running = new Set<Fiber.Fiber<void>>();
  private closed = false;

  constructor(
    readonly component: string,
    /** Services the constructor's handlers need, captured when the Layer was built. */
    private readonly services: Context.Context<never>,
  ) {}

  register(kind: "state", name: string, node: StateNode<unknown>): Effect.Effect<void>;
  register(
    kind: "intent",
    name: string,
    run: (payload: unknown) => Effect.Effect<void, never, Handler>,
  ): Effect.Effect<void>;
  register(kind: "state" | "intent", name: string, value: never): Effect.Effect<void> {
    const map: Map<string, unknown> = kind === "state" ? this.states : this.intents;
    if (map.has(name)) {
      return Effect.die(new DuplicateName({ component: this.component, kind, name }));
    }
    return Effect.sync(() => {
      map.set(name, value);
    });
  }

  recordWrite(name: string, before: unknown, after: unknown): void {
    this.log.push({ _tag: "Write", name, before, after });
  }

  /** Runs an Intent's handler. The handler runs as its own fiber, so it can wait. */
  dispatch(name: string, payload: unknown): void {
    const run = this.intents.get(name);
    if (run === undefined || this.closed) return;
    this.log.push({ _tag: "Intent", name, payload });
    const handler = run(payload).pipe(
      Effect.provideService(Handler, handlerService),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
          this.log.push({ _tag: "Died", intent: name, cause });
          console.error(
            `@alchemy.run/ui: ${this.component}'s ${name} handler died`,
            Cause.pretty(cause),
          );
        }),
      ),
    );
    const fiber = Effect.runForkWith(this.services)(handler);
    this.running.add(fiber);
    fiber.addObserver(() => {
      this.running.delete(fiber);
    });
  }

  close(): Effect.Effect<void> {
    this.closed = true;
    return Fiber.interruptAll([...this.running]);
  }
}

/**
 * Provided only while a component's constructor runs. Declaring state or an
 * Intent requires it, so declarations can't happen anywhere else.
 */
export class Setup extends Context.Service<Setup, Instance>()("@alchemy.run/ui/Setup") {}

/**
 * Provided only while an Intent's handler runs. Writing state requires it, so
 * every write happens inside an Intent and lands in the log.
 */
export class Handler extends Context.Service<Handler, { readonly _: "Handler" }>()(
  "@alchemy.run/ui/Handler",
) {}

const handlerService = { _: "Handler" } as const;

/** A type-level record of something a constructor declared. It never exists at runtime. */
export declare const DeclaresTypeId: unique symbol;
export interface Declares<out D> {
  readonly [DeclaresTypeId]: D;
}

export interface StateDecl<out N extends string, out A> {
  readonly kind: "state";
  readonly name: N;
  readonly value: A;
}

export interface IntentDecl<out N extends string, out P> {
  readonly kind: "intent";
  readonly name: N;
  readonly payload: P;
}
