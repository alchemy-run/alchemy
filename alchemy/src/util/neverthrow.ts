import { err, ok, ResultAsync, type Result } from "neverthrow";
import { promiseWithResolvers } from "./promise-with-resolvers.ts";

export const ensure = <T, E>(
  result: ResultAsync<T, E>,
  finalizer: () => any,
) => {
  return result.andTee(finalizer).orTee(finalizer);
};

export const detached = <T, E>() => {
  const { promise, resolve } = promiseWithResolvers<Result<T, E>>();
  return {
    result: new ResultAsync(promise),
    ok: (value: T) => resolve(ok(value)),
    err: (error: E) => resolve(err(error)),
  };
};

export const singleFlight = <Args extends any[], Value, Error>(
  fn: (...args: Args) => ResultAsync<Value, Error>,
) => {
  const results = new Map<string, ResultAsync<Value, Error>>();
  return (...args: Args): ResultAsync<Value, Error> => {
    const key = JSON.stringify(args ?? []);
    const cached = results.get(key);
    if (cached) {
      return cached;
    }
    const result = fn(...args);
    results.set(key, result);
    return ensure(result, () => {
      results.delete(key);
    });
  };
};

export class HTTPError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// TODO: merge this with safe-fetch?
export const fetchResult = (url: string, init: RequestInit = {}) => {
  return ResultAsync.fromPromise(
    fetch(url, init),
    () => new HTTPError(`Failed to ${init.method ?? "GET"} ${url}`, 0),
  );
};

export const fetchJSON = <T, E>(url: string, init: RequestInit = {}) => {
  return fetchResult(url, init).andThen(decodeJSON<T, E>);
};

export const decodeJSON = <T, E>(response: Response) => {
  return ResultAsync.fromPromise(
    response.json(),
    () => new HTTPError("Failed to decode JSON", response.status),
  ).andThen((json) => (response.ok ? ok(json as T) : err(json as E)));
};
