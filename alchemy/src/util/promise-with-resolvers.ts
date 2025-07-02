/**
 * Node 20+ compatible implementation of Promise.withResolvers()
 * This provides the same functionality as the built-in Promise.withResolvers in Node 22+
 */
export function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Type alias for the return type of promiseWithResolvers
 */
export type PromiseWithResolvers<T> = ReturnType<
  typeof promiseWithResolvers<T>
>;
