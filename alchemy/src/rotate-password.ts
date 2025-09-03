import { Scope } from "./scope.ts";
import { deserialize, serialize } from "./serde.ts";
import { logger } from "./util/logger.ts";

/**
 * Rotates the encryption password for all secrets in the state store.
 * Reads all resources from the state store, decrypts secrets with the old password,
 * re-encrypts them with the new password, and writes them back.
 *
 * @param oldPassword The current password used to decrypt existing secrets
 * @param newPassword The new password to use for encrypting secrets
 * @param fqn Optional fully qualified name to scope the rotation (defaults to rotating all scopes)
 * @returns Promise that resolves when rotation is complete
 *
 * @example
 * // Rotate password for all resources
 * await rotatePassword(
 *   process.env.OLD_PASSWORD,
 *   process.env.NEW_PASSWORD
 * );
 *
 * @example
 * // Rotate password for a specific scope
 * await rotatePassword(
 *   process.env.OLD_PASSWORD,
 *   process.env.NEW_PASSWORD,
 *   "my-app/my-stage"
 * );
 */
export async function rotatePassword(
  oldPassword: string,
  newPassword: string,
  fqn?: string,
): Promise<void> {
  if (!oldPassword) {
    throw new Error("Old password is required");
  }
  if (!newPassword) {
    throw new Error("New password is required");
  }
  if (oldPassword === newPassword) {
    throw new Error("New password must be different from old password");
  }

  const currentScope = Scope.getScope();
  if (!currentScope) {
    throw new Error(
      "Password rotation must be called within an alchemy scope. Use: const app = await alchemy('my-app')",
    );
  }

  const startScope = fqn
    ? findScopeByFqn(currentScope.root, fqn)
    : currentScope.root;
  if (!startScope) {
    throw new Error(`Could not find scope for FQN: ${fqn}`);
  }

  let totalErrorCount = 0;

  async function rotateInScope(scope: Scope): Promise<void> {
    const oldPasswordScope = new Scope({
      parent: scope.parent,
      scopeName: scope.scopeName,
      password: oldPassword,
      stateStore: scope.stateStore,
      quiet: true,
      phase: "read",
      telemetryClient: scope.telemetryClient,
    });

    const newPasswordScope = new Scope({
      parent: scope.parent,
      scopeName: scope.scopeName,
      password: newPassword,
      stateStore: scope.stateStore,
      quiet: true,
      phase: "up",
      telemetryClient: scope.telemetryClient,
    });

    const allStates = await scope.state.all();

    for (const [key, state] of Object.entries(allStates)) {
      try {
        const stateJson = JSON.stringify(state);

        const hasEncryptedSecrets = stateJson.includes('"@secret"');
        const hasUnencryptedSecrets = stateJson.includes('"type":"secret"');

        if (!hasEncryptedSecrets && !hasUnencryptedSecrets) {
          continue;
        }

        logger.task(key, {
          message: `Found secrets in ${key}, rotating...`,
          status: "pending",
          resource: key,
          prefix: "Secret rotation",
          prefixColor: "cyanBright",
        });

        let stateToRotate = state;

        if (hasUnencryptedSecrets && !hasEncryptedSecrets) {
          stateToRotate = await serialize(oldPasswordScope, state, {
            encrypt: true,
          });
        }

        const decrypted = await deserialize(oldPasswordScope, stateToRotate);

        const reencrypted = await serialize(newPasswordScope, decrypted, {
          encrypt: true,
        });

        await scope.state.set(key, reencrypted);

        logger.task(key, {
          message: `Rotated secrets in ${key}`,
          status: "success",
          resource: key,
          prefix: "Secret rotation",
          prefixColor: "cyanBright",
        });
      } catch (error) {
        totalErrorCount++;
        logger.task(key, {
          message: `Failed to rotate secrets for ${key}: ${error}`,
          status: "failure",
          resource: key,
          prefix: "Secret rotation",
          prefixColor: "cyanBright",
        });
      }
    }

    for (const child of scope.children.values()) {
      await rotateInScope(child);
    }
  }

  await rotateInScope(startScope);

  if (totalErrorCount > 0) {
    throw new Error(
      `Password rotation completed with ${totalErrorCount} errors`,
    );
  }
}

function findScopeByFqn(scope: Scope, targetFqn: string): Scope | undefined {
  const currentFqn = scope.chain.join("/");

  if (currentFqn === targetFqn) {
    return scope;
  }

  for (const child of scope.children.values()) {
    const found = findScopeByFqn(child, targetFqn);
    if (found) {
      return found;
    }
  }

  return undefined;
}
