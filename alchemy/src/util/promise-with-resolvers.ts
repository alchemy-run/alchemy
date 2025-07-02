/**
 * Interface for the return type of promiseWithResolvers
 */
export interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

/**
 * Node 20+ compatible implementation of Promise.withResolvers()
 * Falls back to native Promise.withResolvers when available (Node 22+)
 */
export function promiseWithResolvers<T>(): PromiseWithResolvers<T> {
  // Use native implementation if available
  if (typeof Promise.withResolvers === "function") {
    return Promise.withResolvers<T>();
  }

  // Fallback implementation for Node 20+
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
