let _env;
try {
  // @ts-expect-error
  const { env } = await import("cloudflare:workers");
  _env = env;
} catch {
  if (typeof process !== "undefined") {
    _env = process.env;
  } else {
    _env = import.meta.env;
  }
}

export interface Env {
  [key: string]: string | undefined;
}

export const env: Env = _env;

export const toEnvKey = <const ID extends string, const Suffix extends string>(
  id: ID,
  suffix: Suffix,
) => `${replace(toUpper(id))}_${replace(toUpper(suffix))}` as const;

export const toUpper = <const S extends string>(str: S) =>
  str.toUpperCase() as string extends S ? S : Uppercase<S>;

const replace = <const S extends string>(str: S) =>
  str.replace(/-/g, "_") as Replace<S>;

type Replace<S extends string, Accum extends string = ""> = string extends S
  ? S
  : S extends ""
    ? Accum
    : S extends `${infer S}${infer Rest}`
      ? S extends "-"
        ? Replace<Rest, `${Accum}_`>
        : Replace<Rest, `${Accum}${S}`>
      : Accum;
