import { AsyncLocalStorage } from "node:async_hooks";
import type { Input } from "./input";
import { type Output, isOutput } from "./output";

const passphraseContext = new AsyncLocalStorage<string>();

export function secret<S extends Input<string> | undefined>(
  unencrypted: S,
): S extends undefined
  ? never
  : S extends Output<string>
    ? Output<Secret>
    : Secret {
  if (unencrypted === undefined) {
    throw new Error("Secret cannot be undefined");
  }
  return (
    isOutput(unencrypted) ? unencrypted.apply(secret) : new Secret(unencrypted)
  ) as any;
}

export class Secret {
  public readonly type = "secret";
  constructor(readonly unencrypted: string) {}
}

export function setSecretPassphrase(passphrase: string) {
  passphraseContext.enterWith(passphrase);
}

export function getSecretPassphrase(): string {
  const passphrase = passphraseContext.getStore();
  if (!passphrase) {
    throw new Error("No passphrase set");
  }
  return passphrase;
}

export function tryGetSecretPassphrase(): string | undefined {
  return passphraseContext.getStore();
}
