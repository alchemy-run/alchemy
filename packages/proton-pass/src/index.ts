export {
  ProtonPassAuth,
  ProtonPassAuthConfigSchema,
  PROTON_PASS_PERSONAL_ACCESS_TOKEN_ENV,
  type ProtonPassAuthConfig,
  type ProtonPassResolvedCredentials,
} from "./AuthProvider.ts";
export {
  ProtonPassAuthError,
  ProtonPassCliError,
  ProtonPassCliNotFoundError,
  ProtonPassDuplicateFieldError,
  ProtonPassItemError,
  ProtonPassNotLoggedInError,
  ProtonPassReferenceError,
  ProtonPassTimeoutError,
  type ProtonPassOperation,
  type ProtonPassReferenceErrorType,
} from "./Errors.ts";
export {
  Item,
  SecretReferences,
  ProtonPassSecretsProvider,
  type ItemOptions,
  type SecretReferencesOptions,
} from "./SecretsProvider.ts";
