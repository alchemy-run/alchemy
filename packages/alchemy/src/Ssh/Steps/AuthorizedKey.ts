import * as Effect from "effect/Effect";
import { Client, quote } from "../Client.ts";
import {
  applied,
  converged,
  diverged,
  execute,
  type Step,
  type StepPolicy,
} from "../Recipe.ts";
import { runOrFail } from "./internal.ts";

export interface AuthorizedKeyInput {
  /** @default the session user */
  user?: string;
  /** One OpenSSH public key line. */
  key: string;
  sudo?: boolean;
  policy?: StepPolicy;
}

export interface AuthorizedKeyOutput {
  user: string | undefined;
}

export const makeAuthorizedKeyStep = (
  input: AuthorizedKeyInput,
): Step<AuthorizedKeyOutput> => {
  const key = input.key.trim();
  const step = {
    kind: "authorizedKey",
    name: `${input.user ?? "~"}:${key.split(" ").at(-1) ?? key.slice(0, 20)}`,
  };
  const options = { sudo: input.sudo };
  const output = { user: input.user };
  // Resolved from the account, not `$HOME`, which is root's under `sudo -H`.
  // An unknown user fails instead of resolving to `/.ssh`.
  const account = Effect.map(Client, (client) =>
    quote(input.user ?? client.user),
  );
  const home = Effect.map(
    account,
    (user) =>
      `home=$(getent passwd ${user} | cut -d: -f6); [ -n "$home" ] || { echo "no such user: "${user} >&2; exit 1; }`,
  );

  return {
    ...step,
    policy: input.policy,
    check: Effect.gen(function* () {
      const { stdout } = yield* runOrFail(
        step,
        `${yield* home}; if grep -qxF ${quote(key)} "$home/.ssh/authorized_keys" 2>/dev/null; then echo yes; else echo no; fi`,
        options,
      );
      return stdout.trim() === "yes"
        ? converged(output)
        : diverged({ authorized: false }, { authorized: true });
    }),
    apply: Effect.gen(function* () {
      yield* runOrFail(
        step,
        [
          "set -e",
          yield* home,
          'd="$home/.ssh"',
          'mkdir -p "$d"',
          'chmod 700 "$d"',
          'f="$d/authorized_keys"',
          // End an unterminated last line so the key is not appended to it.
          `if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\\n' >> "$f"; fi`,
          `printf '%s\\n' ${quote(key)} >> "$f"`,
          'chmod 600 "$f"',
          `chown -R ${yield* account}: "$d"`,
        ].join("\n"),
        options,
      );
      return applied(output);
    }),
  };
};

/** One public key in a user's `authorized_keys`, matched as a whole line. */
export const authorizedKey = (input: AuthorizedKeyInput) =>
  execute(makeAuthorizedKeyStep(input));
