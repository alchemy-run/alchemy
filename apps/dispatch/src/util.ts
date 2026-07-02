let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Unbounded async queue usable as the streaming-input prompt for the Agent SDK. */
export function asyncQueue<T>() {
  const buffer: T[] = [];
  const waiters: Array<(r: IteratorResult<T>) => void> = [];
  let ended = false;

  return {
    push(item: T) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else buffer.push(item);
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined as never, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const item = buffer.shift();
            if (item !== undefined) {
              return Promise.resolve({ value: item, done: false });
            }
            if (ended) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    } as AsyncIterable<T>,
  };
}
