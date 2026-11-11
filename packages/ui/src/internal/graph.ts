/**
 * The reactive graph: sources, cached computations, and subscribers.
 *
 * Writes push a "maybe changed" mark downstream; subscribers that might have
 * changed are queued and run once per batch. Running a subscriber pulls its
 * source, and a computation recomputes only when one of its sources' versions
 * moved since it last ran, so every subscriber sees a consistent graph and a
 * computation that returns an equal value stops the change from spreading.
 */
import * as Equal from "effect/Equal";

export interface Observer {
  readonly markDirty: () => void;
}

export interface Source<A> {
  /** Increments every time the value changes. */
  readonly version: number;
  readonly read: () => A;
  readonly addObserver: (observer: Observer) => void;
  readonly removeObserver: (observer: Observer) => void;
}

const equals = (a: unknown, b: unknown): boolean => Object.is(a, b) || Equal.equals(a, b);

let batchDepth = 0;
let nextSubscriberId = 0;
const pending = new Set<Subscriber<unknown>>();

/** Runs `f`, deferring subscribers until the outermost batch finishes. */
export const batch = <A>(f: () => A): A => {
  batchDepth++;
  try {
    return f();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
};

const flush = (): void => {
  // A subscriber may write (and so queue more subscribers); keep draining,
  // but never forever.
  for (let round = 0; pending.size > 0; round++) {
    if (round > 100) {
      pending.clear();
      console.error("@alchemy.run/ui: subscribers kept writing to each other for 100 rounds");
      return;
    }
    const queued = [...pending].sort((a, b) => a.id - b.id);
    pending.clear();
    batchDepth++;
    try {
      for (const subscriber of queued) subscriber.run();
    } finally {
      batchDepth--;
    }
  }
};

const notify = (observers: ReadonlySet<Observer>): void => {
  for (const observer of [...observers]) observer.markDirty();
};

export class StateNode<A> implements Source<A> {
  version = 0;
  private readonly observers = new Set<Observer>();
  constructor(private value: A) {}

  read = (): A => this.value;

  /** Returns whether the value changed. */
  write = (next: A): boolean => {
    if (equals(this.value, next)) return false;
    this.value = next;
    this.version++;
    batch(() => notify(this.observers));
    return true;
  };

  addObserver = (observer: Observer): void => {
    this.observers.add(observer);
  };

  removeObserver = (observer: Observer): void => {
    this.observers.delete(observer);
  };
}

export class ComputedNode<A> implements Source<A>, Observer {
  version = 0;
  private value: A | undefined = undefined;
  private initialized = false;
  private dirty = true;
  private sourceVersions: Array<number> = [];
  private readonly observers = new Set<Observer>();

  constructor(
    private readonly sources: ReadonlyArray<Source<unknown>>,
    private readonly compute: (values: ReadonlyArray<unknown>) => A,
  ) {}

  /** Linked while something observes it; unlinked computations pull on every read. */
  private get linked(): boolean {
    return this.observers.size > 0;
  }

  markDirty = (): void => {
    if (this.dirty) return;
    this.dirty = true;
    notify(this.observers);
  };

  read = (): A => {
    this.refresh();
    return this.value as A;
  };

  private refresh(): void {
    if (this.linked && !this.dirty) return;
    let changed = !this.initialized;
    const values = this.sources.map((source, i) => {
      const value = source.read();
      if (source.version !== this.sourceVersions[i]) changed = true;
      return value;
    });
    if (changed) {
      this.sourceVersions = this.sources.map((source) => source.version);
      const next = this.compute(values);
      if (!this.initialized || !equals(this.value, next)) {
        this.value = next;
        this.version++;
      }
      this.initialized = true;
    }
    this.dirty = false;
  }

  addObserver = (observer: Observer): void => {
    if (!this.linked) {
      for (const source of this.sources) source.addObserver(this);
      this.dirty = true;
      this.refresh();
    }
    this.observers.add(observer);
  };

  removeObserver = (observer: Observer): void => {
    this.observers.delete(observer);
    if (!this.linked) {
      for (const source of this.sources) source.removeObserver(this);
      this.dirty = true;
    }
  };
}

export class Subscriber<A> implements Observer {
  readonly id = nextSubscriberId++;
  private lastVersion = -1;
  private disposed = false;

  constructor(
    private readonly source: Source<A>,
    private readonly onChange: (value: A) => void,
  ) {}

  markDirty = (): void => {
    if (!this.disposed) pending.add(this as Subscriber<unknown>);
  };

  run = (): void => {
    if (this.disposed) return;
    const value = this.source.read();
    if (this.source.version === this.lastVersion) return;
    this.lastVersion = this.source.version;
    this.onChange(value);
  };

  dispose = (): void => {
    this.disposed = true;
    pending.delete(this as Subscriber<unknown>);
    this.source.removeObserver(this);
  };
}

/** Calls `onChange` now and after every change; returns the unsubscribe. */
export const subscribe = <A>(source: Source<A>, onChange: (value: A) => void): (() => void) => {
  const subscriber = new Subscriber(source, onChange);
  source.addObserver(subscriber);
  subscriber.run();
  return subscriber.dispose;
};
