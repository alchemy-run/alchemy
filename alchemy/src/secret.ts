export class Secret {
  public readonly type = "secret";
  constructor(readonly unencrypted: string) {}
}

export function isSecret(binding: any): binding is Secret {
  return (
    binding instanceof Secret ||
    (typeof binding === "object" && binding.type === "secret_text")
  );
}

export function secret<S extends string | undefined>(unencrypted: S): Secret {
  if (unencrypted === undefined) {
    throw new Error("Secret cannot be undefined");
  }
  return new Secret(unencrypted);
}
