/** A user, group or service principal referenced by a Virtual Enclaves setting. */
export interface VirtualEnclavesPrincipal {
  /** Entra object ID of the principal. */
  id: string;
  /** Kind of principal. */
  type: "User" | "Group" | "ServicePrincipal";
}

/** An Azure RBAC role granted to principals on community or enclave resources. */
export interface VirtualEnclavesRoleAssignment {
  /** Role definition ID (GUID or full ARM ID). */
  roleDefinitionId: string;
  /**
   * Principals the role is granted to.
   * @default not set
   */
  principals?: VirtualEnclavesPrincipal[];
  /**
   * Optional ABAC condition on the assignment.
   * @default not set
   */
  condition?: string;
}

/** Governance of one Azure service inside a community or enclave. */
export interface VirtualEnclavesGovernedService {
  /**
   * Governed service, e.g. `"Storage"`, `"KeyVault"`, `"AKS"`,
   * `"AppService"`, `"CosmosDB"`, `"MicrosoftSQL"`.
   */
  serviceId: string;
  /**
   * Whether the service is allowed: `Allow`, `Deny`, `ExceptionOnly`, `NotApplicable`.
   * @default not set
   */
  option?: "Allow" | "Deny" | "ExceptionOnly" | "NotApplicable";
  /**
   * Whether policy enforcement is `Enabled` or `Disabled`.
   * @default not set
   */
  enforcement?: "Enabled" | "Disabled";
  /**
   * Policy action: `AuditOnly`, `Enforce` or `None`.
   * @default not set
   */
  policyAction?: "AuditOnly" | "Enforce" | "None";
}

/** Approval requirement for one kind of change request. */
export interface VirtualEnclavesApprovalSetting {
  /**
   * Whether approval is `Required` or `NotRequired`.
   * @default not set
   */
  approvalPolicy?: "Required" | "NotRequired";
  /**
   * Minimum number of approvers.
   * @default not set
   */
  minimumApproversRequired?: number;
  /**
   * Approvers whose approval is always required (Entra object IDs).
   * @default not set
   */
  mandatoryApprovers?: {
    /** Entra object ID of the approver. */
    approverEntraId: string;
  }[];
}

/** Maintenance mode of a community or enclave. */
export interface VirtualEnclavesMaintenanceMode {
  /** Maintenance mode: `On`, `CanNotDelete`, `Off`, `General` or `Advanced`. */
  mode: "On" | "CanNotDelete" | "Off" | "General" | "Advanced";
  /**
   * Principals exempt from maintenance mode.
   * @default not set
   */
  principals?: VirtualEnclavesPrincipal[];
  /**
   * Justification: `Networking`, `Governance` or `Off`.
   * @default not set
   */
  justification?: "Networking" | "Governance" | "Off";
}

/** Where diagnostic logs or flow logs are sent. */
export interface VirtualEnclavesMonitoringDestination {
  /** Destination kind. */
  destinationType: "CommunityWorkspace" | "EnclaveWorkspace" | "CustomWorkspace";
  /**
   * Log Analytics workspace ID for a custom destination.
   * @default not set
   */
  customWorkspaceResourceId?: string;
  /**
   * Name of the diagnostic setting.
   * @default not set
   */
  diagnosticSettingsName?: string;
}

/** Diagnostic and flow-log destinations. */
export interface VirtualEnclavesMonitoringSettings {
  /**
   * Diagnostic log destinations.
   * @default not set
   */
  diagnosticDestinations?: VirtualEnclavesMonitoringDestination[];
  /**
   * Flow log destination.
   * @default not set
   */
  flowLogDestination?: VirtualEnclavesMonitoringDestination;
}

/** Managed identity type of a community or enclave. */
export type VirtualEnclavesIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

/** Approval requirements of a community, per kind of change request. */
export interface CommunityApprovalSettings {
  /**
   * Approval for community endpoint updates.
   * @default not set
   */
  communityEndpointUpdate?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave endpoint updates.
   * @default not set
   */
  enclaveEndpointUpdate?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave creation.
   * @default not set
   */
  enclaveCreation?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave connection creation.
   * @default not set
   */
  connectionCreation?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave connection updates.
   * @default not set
   */
  connectionUpdate?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for community maintenance mode changes.
   * @default not set
   */
  communityMaintenanceMode?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave maintenance mode changes.
   * @default not set
   */
  enclaveMaintenanceMode?: VirtualEnclavesApprovalSetting;
}

/** Approval requirements of a virtual enclave, per kind of change request. */
export interface VirtualEnclaveApprovalSettings {
  /**
   * Approval for enclave endpoint updates.
   * @default not set
   */
  enclaveEndpointUpdate?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave connection creation.
   * @default not set
   */
  connectionCreation?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave connection updates.
   * @default not set
   */
  connectionUpdate?: VirtualEnclavesApprovalSetting;
  /**
   * Approval for enclave maintenance mode changes.
   * @default not set
   */
  enclaveMaintenanceMode?: VirtualEnclavesApprovalSetting;
}
