/**
 * Microsoft Entra application the Azure Migrate appliance authenticates
 * with when it talks to a discovery site.
 */
export interface SiteServicePrincipal {
  /** Tenant ID of the application. */
  tenantId?: string;
  /** Application (client) ID. */
  applicationId?: string;
  /** Object ID of the application's service principal. */
  objectId?: string;
  /** Audience (resource) the appliance requests tokens for. */
  audience?: string;
  /** Microsoft Entra authority URL, e.g. `https://login.windows.net/<tenant>`. */
  aadAuthority?: string;
  /** Base64 public certificate the appliance signs in with. */
  rawCertData?: string;
}

/** Key Vault the appliance agent of a discovery site stores secrets in. */
export interface SiteAgentKeyVault {
  /** URI of the Key Vault, e.g. `https://my-vault.vault.azure.net/`. */
  keyVaultUri?: string;
  /** ARM resource ID of the Key Vault. */
  keyVaultId?: string;
}

/**
 * Microsoft Entra application an assessment collector's appliance agent
 * authenticates with.
 */
export interface CollectorServicePrincipal {
  /** Tenant ID of the application. */
  tenantId?: string;
  /** Application (client) ID. */
  applicationId?: string;
  /** Object ID of the application's service principal. */
  objectId?: string;
  /** Audience (resource) the agent requests tokens for. */
  audience?: string;
  /** Microsoft Entra authority URL, e.g. `https://login.windows.net/<tenant>`. */
  authority?: string;
}
