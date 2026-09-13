interface Env {
  FETCHER: Fetcher;
}
export default function (env: Env) {
  const details = async (
    flagKey: string,
    defaultValue: unknown,
    type?: string,
    context?: unknown,
  ) => {
    const response = await env.FETCHER.fetch("http://flagship/evaluate", {
      method: "POST",
      body: JSON.stringify({ flagKey, defaultValue, type, context }),
    });
    if (!response.ok)
      return {
        flagKey,
        value: defaultValue,
        reason: "ERROR",
        errorCode: "GENERAL",
        errorMessage: await response.text(),
      };
    return response.json() as Promise<{ flagKey: string; value: unknown }>;
  };
  return {
    get: async (key: string, value?: unknown, context?: unknown) =>
      (await details(key, value, undefined, context)).value,
    ...Object.fromEntries(
      ["Boolean", "String", "Number", "Object"].flatMap((type) => [
        [
          `get${type}Value`,
          async (key: string, value: unknown, context?: unknown) =>
            (await details(key, value, type.toLowerCase(), context)).value,
        ],
        [
          `get${type}Details`,
          (key: string, value: unknown, context?: unknown) =>
            details(key, value, type.toLowerCase(), context),
        ],
      ]),
    ),
  };
}
