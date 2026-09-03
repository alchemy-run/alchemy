import * as AI from "alchemy/AI";
import { floci, nameOf } from "../github/Repos.ts";
import { FindCompanions } from "../review/Companions.ts";
import { SandboxGuidance } from "../sandbox/SandboxGuidance.ts";

/**
 * How the org works in FLOCI — the local AWS emulator `alchemy dev`
 * runs AWS providers against, and one unit with the alchemy
 * repository: an AWS resource is not done locally until floci speaks
 * its API. Activated when a change adds or alters an AWS provider,
 * touches `.vendor/floci`, or is a companion pull request in
 * `alchemy-run/floci`.
 */
export class FlociGuidance extends AI.Skill<FlociGuidance>(import.meta)(
  "FlociGuidance",
) {}

export const FlociGuidanceGeneral = FlociGuidance.make`
  # Working in floci

  ${nameOf(floci)} is alchemy's fork of floci: a Java 25 / Quarkus
  LocalStack-style AWS emulator on port 4566 that speaks the REAL AWS
  wire protocols. \`alchemy dev\` starts it as one Docker container
  (\`alchemy-floci\`, image \`ghcr.io/alchemy-run/floci\`; override with
  \`ALCHEMY_FLOCI_IMAGE\`) and deploys AWS resources into it: the SAME
  reconciler that runs against AWS runs against floci through the
  endpoint override (\`flociServices()\` in the provider's \`dual\`
  registration), and resource identities carry the \`dev:\` marker as
  proof no cloud call ran. So an AWS resource works locally exactly
  when floci implements its operations faithfully — the emulation IS
  the local provider.

  In the alchemy tree floci is a reference-only vendor submodule at
  \`.vendor/floci\` (\`update = none\`; fetch it explicitly with
  \`git submodule update --init --checkout -- .vendor/floci\`). The
  session image carries the host-built jar (\`.vendor/floci/target\`)
  but no JDK: a session that must RUN or BUILD it installs java first
  (\`dnf install -y java-25-amazon-corretto-headless\`, ~30s) — see
  ${SandboxGuidance.source} for what the machine ships.

  ## Floci's own rules

  Preserve AWS protocol compatibility over convenience: no custom
  endpoint shapes, no simplified request or response formats. The
  design is layered — a Controller parses the protocol and shapes the
  response, a Service holds the logic and throws \`AwsException\`, a
  \`model/\` holds the domain objects — under
  \`services/<service>/\`; COPY an existing service's pattern before
  inventing one, and register the service in \`ServiceRegistry\` with
  its config in \`EmulatorConfig\` and both \`application.yml\`s. The
  protocol decides the controller: Query (form-encoded \`Action\`, XML
  out — SQS, SNS, IAM, STS, …) through \`AwsQueryController\`; JSON 1.1
  (\`X-Amz-Target\` — SSM, EventBridge, Kinesis, KMS, …) through
  \`AwsJson11Controller\`; REST JSON (Lambda, API Gateway) and REST XML
  (S3) as JAX-RS resources. XML goes through \`XmlBuilder\` and
  \`XmlParser\`, never regex; storage through \`StorageFactory\`, never a
  direct implementation.

  Every behavior that affects compatibility is TESTED — unit tests
  \`*ServiceTest.java\`, integration tests \`*IntegrationTest.java\`,
  validated with real AWS SDK clients rather than handcrafted HTTP
  (\`./mvnw test -Dtest=SsmIntegrationTest\`; the whole suite \`./mvnw
  test\`; a jar \`./mvnw clean package -DskipTests\`). Alchemy holds
  the emulator to the same bar as the cloud: its AWS suites also run
  against floci (\`{Resource}.local.test.ts\`, skipped without Docker),
  and every fidelity gap they surface is a fix in the fork, never a
  workaround in the provider.

  ## The companion pull request

  A new AWS resource in alchemy is expected to ARRIVE with its
  emulation: a companion pull request in ${nameOf(floci)} from a
  branch of the SAME NAME, so the resource works under \`alchemy dev\`
  the day it lands, proven by the alchemy side's
  \`{Resource}.local.test.ts\`. Nothing pins floci in the alchemy tree
  (the image is released separately), so the pairing is the branch
  name and the description: the alchemy pull request names its
  companion, or says why the emulation is deferred. Reviewing,
  ${FindCompanions.source} finds the companion by branch name; an
  absent emulation is a NOTE in the review, not a blocker on its own —
  an unexplained one is a problem to name.`;
