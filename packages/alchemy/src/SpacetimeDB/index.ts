export * as Auth from "./AuthProvider.ts";
export {
  makeSpacetimeDBAuth,
  readEnvCredentials,
  SPACETIMEDB_AUTH_PROVIDER_NAME,
  SpacetimeDBAuth,
  type SpacetimeDBAuthConfig,
  type SpacetimeDBAuthOptions,
  type SpacetimeDBResolvedCredentials,
  type SpacetimeDBStoredCredentials,
} from "./AuthProvider.ts";
export {
  buildViaCli,
  clearDataFlag,
  deleteViaCli,
  generateViaCli,
  localDevArgs,
  lockViaCli,
  publishViaCli,
  renameViaCli,
  runSpacetime,
  scrapeIdentity,
  SpacetimeCliError,
  SpacetimeCliNotFound,
  unlockViaCli,
  type ClearDataMode,
  type PublishViaCliOptions,
  type PublishViaCliResult,
} from "./Cli.ts";
export {
  decodeTokenIdentity,
  makeClient,
  SpacetimeDBClient,
  SpacetimeDBDecodeError,
  SpacetimeDBHttpError,
  SpacetimeDBNotFound,
  SpacetimeDBPermissionDenied,
  type DatabaseInfo,
  type PublishResult,
  type SpacetimeDBClient as SpacetimeDBClientService,
  type SqlStatementResult,
} from "./Client.ts";
export {
  Connect,
  connectEnvKeys,
  viteEnv,
  type ConnectClient,
  type ConnectEnvKeys,
} from "./Connect.ts";
export { ConnectBinding } from "./ConnectBinding.ts";
export {
  fromAuthProvider,
  fromEnv,
  fromToken,
  SpacetimeDBCredentials,
  type SpacetimeDBCredentialsService,
} from "./Credentials.ts";
export {
  createDatabaseName,
  Database,
  DATABASE_NAME_RE,
  DatabaseProvider,
  DatabaseProviderLive,
  parseLogLines,
  resolveModuleSource,
  type DatabaseAttributes,
  type DatabaseProps,
  type ModuleSource,
} from "./Database.ts";
export {
  DatabaseHttp,
  makeDatabaseHttpLayer,
  makeDatabaseHttpLayerFromConnect,
  type DatabaseHttpService,
} from "./DatabaseHttp.ts";
export {
  Generate,
  GenerateProvider,
  type GenerateAttributes,
  type GenerateProps,
} from "./Generate.ts";
export {
  dashboardUrl,
  DEFAULT_HOST,
  normalizeHost,
  resolveHostFromEnv,
  toWebSocketUri,
} from "./Host.ts";
export {
  Project,
  ProjectProvider,
  type ProjectAttributes,
  type ProjectChild,
  type ProjectGenerateTarget,
  type ProjectProps,
} from "./Project.ts";
export {
  providers,
  Providers,
  type ProviderRequirements,
  type ProvidersOptions,
} from "./Providers.ts";
export {
  Connection,
  makeConnectionLayer,
  makeConnectionLayerFromConnect,
  SpacetimeDBConnectionError,
  type ConnectionConfig,
  type DbConnectionBuilderLike,
  type DbConnectionFactory,
  type Disconnectable,
} from "./Runtime.ts";
export {
  /** @deprecated Use SpacetimeAuthProject (the OIDC resource was renamed). */
  SpacetimeAuthProject as SpacetimeAuth,
  SpacetimeAuthProject,
  SpacetimeAuthProjectProvider,
  type SpacetimeAuthProjectAttributes,
  type SpacetimeAuthProjectProps,
} from "./SpacetimeAuth.ts";
export {
  storageKeyFor,
  withTokenPersistence,
  type BrowserConnectionOptions,
  type BrowserStorage,
} from "./Browser.ts";
