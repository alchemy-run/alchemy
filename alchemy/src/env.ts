export interface Env {
  [key: string]: Promise<string>;
  <T = string>(name: string, value?: T | undefined, error?: string): Promise<T>;
}

export const env = new Proxy(_env, {
  get: (_, name: string) => _env(name),
  apply: (_, __, args: [string, any?, string?]) => _env(...args),
}) as Env;

async function _env<T = string>(
  name: string,
  value?: T | undefined,
  error?: string,
): Promise<T> {
  if (value !== undefined) {
    return value;
  }
  const env = await resolveEnv();
  if (name in env) {
    return env[name] as T;
  }
  throw new Error(error ?? `Environment variable ${name} is not set`);
}

async function resolveEnv(): Promise<Record<string, any>> {
  if (typeof process !== "undefined") {
    return process.env;
  }
  try {
    const { env } = await import("cloudflare:workers");
    return env;
  } catch (_error) {}
  if (typeof import.meta !== "undefined") {
    return import.meta.env;
  }
  throw new Error("No environment found");
}
