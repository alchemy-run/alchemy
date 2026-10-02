import * as Layer from "effect/Layer";
import { AutomationAccount, AutomationAccountProvider } from "./AutomationAccount.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { ConnectionType, ConnectionTypeProvider } from "./ConnectionType.ts";
import { Credential, CredentialProvider } from "./Credential.ts";
import { HybridRunbookWorkerGroup, HybridRunbookWorkerGroupProvider } from "./HybridRunbookWorkerGroup.ts";
import { Schedule, ScheduleProvider } from "./Schedule.ts";
import { Variable, VariableProvider } from "./Variable.ts";

export const resources = [
  AutomationAccount,
  Certificate,
  Connection,
  ConnectionType,
  Credential,
  HybridRunbookWorkerGroup,
  Schedule,
  Variable,
];
export const layers = () =>
  Layer.mergeAll(
    AutomationAccountProvider(),
    CertificateProvider(),
    ConnectionProvider(),
    ConnectionTypeProvider(),
    CredentialProvider(),
    HybridRunbookWorkerGroupProvider(),
    ScheduleProvider(),
    VariableProvider(),
  );
