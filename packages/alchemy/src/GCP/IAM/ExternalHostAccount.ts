import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  deleteHostServiceAccount,
  ensureHostServiceAccount,
  syncHostIam,
  type AppliedIamGrant,
  type GcpHostBinding,
} from "../Host.ts";
import type { Providers } from "../Providers.ts";

/**
 * The service account an external host (a Cloudflare Worker, an AWS Lambda,
 * …) uses to reach GCP: GCP bindings on the host grant their roles to it,
 * and the host signs with one of its keys, delivered through the host's env.
 * Created by `GCPBindings` for each external host; not a user-facing
 * resource.
 *
 * @internal
 */
export type ExternalHostAccount = Resource<
  "GCP.IAM.ExternalHostAccount",
  {
    /** The external host's resource type, hashed into the account id. */
    hostType: string;
  },
  {
    /** Full resource name `projects/{project}/serviceAccounts/{email}`. */
    name: string;
    project: string;
    email: string;
    /** Resource name of the key the host signs with. */
    keyName: string;
    /** The key's `private_key_id`. */
    privateKeyId: string;
    /** The key's PKCS #8 PEM private key. */
    privateKey: Redacted.Redacted<string>;
    /** Roles granted to the account, revoked once no binding asks for them. */
    iamGrants: AppliedIamGrant[];
  },
  GcpHostBinding,
  Providers
>;

export const ExternalHostAccount = Resource<ExternalHostAccount>("GCP.IAM.ExternalHostAccount");

/** The fields of a `TYPE_GOOGLE_CREDENTIALS_FILE` key the host needs. */
const decodeKeyFile = (privateKeyData: string) =>
  Effect.try({
    try: () => {
      const file = JSON.parse(Buffer.from(privateKeyData, "base64").toString("utf8")) as {
        private_key_id: string;
        private_key: string;
      };
      return { privateKeyId: file.private_key_id, privateKey: Redacted.make(file.private_key) };
    },
    // The cause can quote key material, so it is not attached.
    catch: () => new ExternalHostKeyInvalid({ keyName: "" }),
  });

export class ExternalHostKeyInvalid extends Data.TaggedError("GCP.ExternalHostKeyInvalid")<{
  keyName: string;
}> {}

export const ExternalHostAccountProvider = () =>
  Provider.succeed(ExternalHostAccount, {
    stables: ["name", "project", "email"],

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const env = yield* GcpEnvironment.current;
      const project = output?.project ?? env.project;

      // Observe + ensure: the account id is derived from the host, so a
      // re-run (or a lost state row) finds the same account. External hosts
      // don't run as the account, so no serverless `actAs` grant.
      // Hashed from the stage-unique physical name, so stages sharing a
      // project never share an account.
      const { email } = yield* ensureHostServiceAccount({
        project,
        hostType: news.hostType,
        resourceName: `${project}/${yield* createPhysicalName({ id })}`,
        actAs: false,
      });
      const name = `projects/${project}/serviceAccounts/${email}`;

      // Sync the account's roles onto the host's bindings.
      const { grants } = yield* syncHostIam({
        project,
        serviceAccount: email,
        managed: true,
        bindings,
        previous: output?.iamGrants,
      });

      // Ensure the key: keep the one we made while it still exists, since
      // its private half is only returned on create.
      const existingKey =
        output?.keyName !== undefined
          ? yield* iam
              .getProjectsServiceAccountsKeys({ name: output.keyName })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)))
          : undefined;
      if (existingKey !== undefined && output !== undefined) {
        return { ...output, name, project, email, iamGrants: grants };
      }
      // A new account is eventually consistent: key creation can 404 for a
      // few seconds after the account is created.
      const key = yield* iam
        .createProjectsServiceAccountsKeys({
          name,
          body: { privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE" },
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      return {
        name,
        project,
        email,
        keyName: key.name ?? "",
        ...(yield* decodeKeyFile(key.privateKeyData ?? "")),
        iamGrants: grants,
      };
    }),

    // Deleting the account revokes its grants and deletes its keys.
    delete: Effect.fn(function* ({ output }) {
      yield* deleteHostServiceAccount({
        project: output.project,
        email: output.email,
        grants: output.iamGrants,
      });
    }),
  });
