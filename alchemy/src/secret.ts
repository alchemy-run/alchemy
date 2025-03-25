import { isPromise } from "./output";

export class Secret {
  public readonly type = "secret";
  constructor(readonly unencrypted: string) {}
}

export function secret<S extends string | Promise<string> | undefined>(
  unencrypted: S,
): S extends undefined
  ? never
  : S extends Promise<string>
    ? Promise<Secret>
    : Secret {
  if (unencrypted === undefined) {
    throw new Error("Secret cannot be undefined");
  }
  return (
    isPromise(unencrypted)
      ? unencrypted.then((u: any) => {
          return secret(u);
        })
      : new Secret(unencrypted)
  ) as any;
}
