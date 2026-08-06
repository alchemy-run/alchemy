/**
 * Shared type-id constants for the Celld namespace. Kept in a leaf module
 * (no imports) so runtime-bundled files (`FleetGateway.ts`,
 * `FleetRuntimeContext.ts`) and deploy-time files (`Fleet.ts`,
 * `DurableObject.ts`) can share them without dragging deploy-time code into
 * the fleet bundle.
 */
export const FleetTypeId = "Celld.Fleet";
export type FleetTypeId = typeof FleetTypeId;

export const WorkerTypeId = "Celld.Worker";
export type WorkerTypeId = typeof WorkerTypeId;

export const DurableObjectTypeId = "Celld.DurableObject";
export type DurableObjectTypeId = typeof DurableObjectTypeId;
