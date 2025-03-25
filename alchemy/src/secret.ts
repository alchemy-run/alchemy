export class Secret {
  public readonly type = "secret";
  constructor(readonly unencrypted: string) {}
}

export function secret<S extends string | undefined>(unencrypted: S): Secret {
  if (unencrypted === undefined) {
    throw new Error("Secret cannot be undefined");
  }
  return new Secret(unencrypted);
}
