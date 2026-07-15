import { InstanceProfile } from "@/AWS/IAM/InstanceProfile.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as ImageBuilder from "@/AWS/ImageBuilder";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ImageBuilderTestFunction extends Lambda.Function<Lambda.Function>()(
  "ImageBuilderTestFunction",
) {}

const componentData = [
  "name: alchemy-imagebuilder-bindings-component",
  "description: no-op component used by alchemy binding tests",
  "schemaVersion: 1.0",
  "phases:",
  "  - name: build",
  "    steps:",
  "      - name: hello",
  "        action: ExecuteBash",
  "        inputs:",
  "          commands:",
  "            - echo hello-from-alchemy-bindings",
].join("\n");

export default ImageBuilderTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The pipeline the pipeline-scoped bindings are bound to. ENABLED but
    // with no schedule, so it only builds when the Start binding fires.
    const role = yield* Role("BindingsBuilderRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder",
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      ],
    });
    const profile = yield* InstanceProfile("BindingsBuilderProfile", {
      roleName: role.roleName,
    });
    const component = yield* ImageBuilder.Component("BindingsComponent", {
      platform: "Linux",
      data: componentData,
    });
    const recipe = yield* ImageBuilder.ImageRecipe("BindingsRecipe", {
      // The testing account deploys to us-west-2 (region is fixed here
      // because AWSEnvironment is deploy-only and this effect re-runs at
      // Lambda init).
      parentImage:
        "arn:aws:imagebuilder:us-west-2:aws:image/amazon-linux-2023-x86/x.x.x",
      components: [{ componentArn: component.componentBuildVersionArn }],
    });
    const infra = yield* ImageBuilder.InfrastructureConfiguration(
      "BindingsInfra",
      {
        instanceProfileName: profile.instanceProfileName,
        instanceTypes: ["t3.micro"],
        terminateInstanceOnFailure: true,
      },
    );
    const pipeline = yield* ImageBuilder.ImagePipeline("BindingsPipeline", {
      imageRecipeArn: recipe.imageRecipeArn,
      infrastructureConfigurationArn: infra.infrastructureConfigurationArn,
      // Disable tests so a cancelled build never proceeds to a test phase.
      imageTestsConfiguration: { imageTestsEnabled: false, timeout: "1 hour" },
    });

    // Event source: subscribe the host to image state-change events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* ImageBuilder.consumeImageEvents(
      { kinds: ["image-state-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `image state change: ${event.resources[0]} -> ${event.detail.state?.status}`,
          ),
        ),
    );

    const getPipeline = yield* ImageBuilder.GetImagePipeline(pipeline);
    const listPipelineImages =
      yield* ImageBuilder.ListImagePipelineImages(pipeline);
    const startBuild =
      yield* ImageBuilder.StartImagePipelineExecution(pipeline);
    const getImage = yield* ImageBuilder.GetImage();
    const cancelBuild = yield* ImageBuilder.CancelImageCreation();
    const deleteImage = yield* ImageBuilder.DeleteImage();
    const listImages = yield* ImageBuilder.ListImages();
    const listWorkflowExecutions = yield* ImageBuilder.ListWorkflowExecutions();

    const bound = {
      getPipeline,
      listPipelineImages,
      startBuild,
      getImage,
      cancelBuild,
      deleteImage,
      listImages,
      listWorkflowExecutions,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Pipeline-scoped read: the pipeline ARN is injected.
        if (request.method === "GET" && pathname === "/pipeline") {
          const { imagePipeline } = yield* getPipeline();
          return yield* HttpServerResponse.json({
            arn: imagePipeline?.arn,
            name: imagePipeline?.name,
            status: imagePipeline?.status,
            timeoutMinutes:
              imagePipeline?.imageTestsConfiguration?.timeoutMinutes,
          });
        }

        // Pipeline-scoped list of the builds this pipeline produced.
        if (request.method === "GET" && pathname === "/pipeline-images") {
          const { imageSummaryList } = yield* listPipelineImages();
          return yield* HttpServerResponse.json({
            arns: (imageSummaryList ?? []).map((image) => image.arn),
          });
        }

        // Account-level image listing.
        if (request.method === "GET" && pathname === "/images") {
          const { imageVersionList } = yield* listImages({ owner: "Self" });
          return yield* HttpServerResponse.json({
            count: (imageVersionList ?? []).length,
          });
        }

        // Kick off a build of the bound pipeline.
        if (request.method === "POST" && pathname === "/build/start") {
          const { imageBuildVersionArn } = yield* startBuild();
          return yield* HttpServerResponse.json({ imageBuildVersionArn });
        }

        // Cancel an in-flight build.
        if (request.method === "POST" && pathname === "/build/cancel") {
          const { imageBuildVersionArn } = yield* cancelBuild({
            imageBuildVersionArn: arn,
          });
          return yield* HttpServerResponse.json({ imageBuildVersionArn });
        }

        // Read a build version's state.
        if (request.method === "GET" && pathname === "/build") {
          const { image } = yield* getImage({ imageBuildVersionArn: arn });
          return yield* HttpServerResponse.json({
            status: image?.state?.status,
          });
        }

        // Drill into the build's workflow runs.
        if (request.method === "GET" && pathname === "/build/workflows") {
          const { workflowExecutions } = yield* listWorkflowExecutions({
            imageBuildVersionArn: arn,
          });
          return yield* HttpServerResponse.json({
            count: (workflowExecutions ?? []).length,
          });
        }

        // Prune a build version; not-yet-deletable states report why so the
        // test can poll until the build settles.
        if (request.method === "DELETE" && pathname === "/build") {
          const result = yield* deleteImage({
            imageBuildVersionArn: arn,
          }).pipe(
            Effect.map(() => ({ deleted: true as const })),
            Effect.catchTag(
              ["InvalidRequestException", "ResourceDependencyException"],
              (error) =>
                Effect.succeed({ deleted: false as const, reason: error._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        ImageBuilder.GetImagePipelineHttp,
        ImageBuilder.ListImagePipelineImagesHttp,
        ImageBuilder.StartImagePipelineExecutionHttp,
        ImageBuilder.GetImageHttp,
        ImageBuilder.CancelImageCreationHttp,
        ImageBuilder.DeleteImageHttp,
        ImageBuilder.ListImagesHttp,
        ImageBuilder.ListWorkflowExecutionsHttp,
      ),
    ),
  ),
);
