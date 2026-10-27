import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { outcome, probeParam, serveProbes } from "../../bindingHost.ts";

/** Repository the host lists (roles/artifactregistry.reader on it). */
export const Images = GCP.ArtifactRegistry.Repository("Images", {
  location: "us-central1",
  format: "DOCKER",
});

/** Docker repository the generated bindings manage (the test pushes an image into it). */
export const Packages = GCP.ArtifactRegistry.Repository("Packages", {
  location: "us-central1",
  format: "DOCKER",
});

const repository = (id: string, format: string) =>
  GCP.ArtifactRegistry.Repository(id, { location: "us-central1", format });

/** Empty repositories of each format the format-specific bindings read or import into. */
export const Maven = repository("Maven", "MAVEN");
export const Npm = repository("Npm", "NPM");
export const Python = repository("Python", "PYTHON");
export const Apt = repository("Apt", "APT");
export const Yum = repository("Yum", "YUM");
export const Googet = repository("Googet", "GOOGET");

/** A bucket path that doesn't exist: imports and exports reach the API and fail there. */
const MISSING_GCS = "gs://alchemy-binding-missing-bucket/none";

/**
 * Effect-native Cloud Run service exercising every Artifact Registry
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ArtifactRegistryBindingsHost extends GCP.Function<ArtifactRegistryBindingsHost>()(
  "ArtifactRegistryBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const AR = GCP.ArtifactRegistry;
    const listImages = yield* AR.ListDockerImages(Images);

    const getRepository = yield* AR.GetRepository(Packages);
    const listPackages = yield* AR.ListRepositoryPackages(Packages);
    const getPackage = yield* AR.GetRepositoryPackage(Packages);
    const patchPackage = yield* AR.PatchRepositoryPackage(Packages);
    const deletePackage = yield* AR.DeleteRepositoryPackage(Packages);
    const listVersions = yield* AR.ListRepositoryPackageVersions(Packages);
    const getVersion = yield* AR.GetRepositoryPackageVersion(Packages);
    const patchVersion = yield* AR.PatchRepositoryPackageVersion(Packages);
    const deleteVersion = yield* AR.DeleteRepositoryPackageVersion(Packages);
    const batchDeleteVersions = yield* AR.BatchDeleteRepositoryPackageVersions(Packages);
    const listTags = yield* AR.ListRepositoryPackageTags(Packages);
    const getTag = yield* AR.GetRepositoryPackageTag(Packages);
    const createTag = yield* AR.CreateRepositoryPackageTag(Packages);
    const patchTag = yield* AR.PatchRepositoryPackageTag(Packages);
    const deleteTag = yield* AR.DeleteRepositoryPackageTag(Packages);
    const listFiles = yield* AR.ListRepositoryFiles(Packages);
    const getFile = yield* AR.GetRepositoryFile(Packages);
    const patchFile = yield* AR.PatchRepositoryFile(Packages);
    const downloadFile = yield* AR.DownloadRepositoryFile(Packages);
    const deleteFile = yield* AR.DeleteRepositoryFile(Packages);
    const getDockerImage = yield* AR.GetRepositoryDockerImage(Packages);
    const listRules = yield* AR.ListRepositoryRules(Packages);
    const getRule = yield* AR.GetRepositoryRule(Packages);
    const createRule = yield* AR.CreateRepositoryRule(Packages);
    const patchRule = yield* AR.PatchRepositoryRule(Packages);
    const deleteRule = yield* AR.DeleteRepositoryRule(Packages);
    const listAttachments = yield* AR.ListRepositoryAttachments(Packages);
    const getAttachment = yield* AR.GetRepositoryAttachment(Packages);
    const createAttachment = yield* AR.CreateRepositoryAttachment(Packages);
    const deleteAttachment = yield* AR.DeleteRepositoryAttachment(Packages);
    const exportArtifact = yield* AR.ExportRepositoryArtifact(Packages);

    const listMaven = yield* AR.ListRepositoryMavenArtifacts(Maven);
    const getMaven = yield* AR.GetRepositoryMavenArtifact(Maven);
    const listNpm = yield* AR.ListRepositoryNpmPackages(Npm);
    const getNpm = yield* AR.GetRepositoryNpmPackage(Npm);
    const listPython = yield* AR.ListRepositoryPythonPackages(Python);
    const getPython = yield* AR.GetRepositoryPythonPackage(Python);
    const importApt = yield* AR.ImportRepositoryAptArtifact(Apt);
    const importYum = yield* AR.ImportRepositoryYumArtifact(Yum);
    const importGooget = yield* AR.ImportRepositoryGoogetArtifact(Googet);

    const pkg = probeParam("package");
    const version = probeParam("version");
    const tag = probeParam("tag");
    const file = probeParam("file");
    const rule = probeParam("rule");
    const attachment = probeParam("attachment");
    const params = <A>(f: (p: Record<string, string>) => A) =>
      Effect.map(Effect.all({ package: pkg, version, tag, file, rule, attachment }), (p) => f(p));

    return {
      fetch: serveProbes({
        listDockerImages: listImages({ pageSize: 10 }),

        getRepository: getRepository(),
        listPackages: listPackages(),
        getPackage: Effect.flatMap(pkg, (p) => getPackage({ package: p })),
        patchPackage: Effect.flatMap(pkg, (p) =>
          patchPackage({
            package: p,
            updateMask: "annotations",
            body: { annotations: { "alchemy-binding": "package" } },
          }),
        ),
        listVersions: Effect.flatMap(pkg, (p) => listVersions({ package: p })),
        getVersion: Effect.flatten(
          params((p) => getVersion({ package: p.package!, version: p.version! })),
        ),
        patchVersion: Effect.flatten(
          params((p) =>
            patchVersion({
              package: p.package!,
              version: p.version!,
              updateMask: "annotations",
              body: { annotations: { "alchemy-binding": "version" } },
            }),
          ),
        ),
        listTags: Effect.flatMap(pkg, (p) => listTags({ package: p })),
        getTag: Effect.flatten(params((p) => getTag({ package: p.package!, tag: p.tag! }))),
        // `?version=` is the version's full name, which a tag points at.
        createTag: Effect.flatten(
          params((p) =>
            createTag({ package: p.package!, tagId: p.tag!, body: { version: p.version! } }),
          ),
        ),
        patchTag: Effect.flatten(
          params((p) =>
            patchTag({
              package: p.package!,
              tag: p.tag!,
              updateMask: "version",
              body: { version: p.version! },
            }),
          ),
        ),
        deleteTag: Effect.flatten(params((p) => deleteTag({ package: p.package!, tag: p.tag! }))),
        listFiles: listFiles(),
        getFile: Effect.flatMap(file, (f) => getFile({ file: f })),
        patchFile: Effect.flatMap(file, (f) =>
          patchFile({
            file: f,
            updateMask: "annotations",
            body: { annotations: { "alchemy-binding": "file" } },
          }),
        ),
        downloadFile: Effect.flatMap(file, (f) => outcome(downloadFile({ file: f }))),
        getDockerImage: Effect.flatMap(probeParam("image"), (dockerImage) =>
          getDockerImage({ dockerImage }),
        ),
        createRule: Effect.flatten(
          params((p) =>
            createRule({
              ruleId: p.rule!,
              body: { action: "DENY", operation: "DOWNLOAD", packageId: p.package! },
            }),
          ),
        ),
        listRules: listRules(),
        getRule: Effect.flatMap(rule, (r) => getRule({ rule: r })),
        patchRule: Effect.flatMap(rule, (r) =>
          patchRule({ rule: r, updateMask: "action", body: { action: "ALLOW" } }),
        ),
        deleteRule: Effect.flatMap(rule, (r) => deleteRule({ rule: r })),
        createAttachment: Effect.flatten(
          params((p) =>
            createAttachment({
              attachmentId: p.attachment!,
              body: {
                target: p.version!,
                type: "application/vnd.alchemy.binding",
                files: [p.file!],
              },
            }),
          ),
        ),
        listAttachments: listAttachments(),
        getAttachment: Effect.flatMap(attachment, (a) => getAttachment({ attachment: a })),
        deleteAttachment: Effect.flatMap(attachment, (a) => deleteAttachment({ attachment: a })),
        exportArtifact: Effect.flatMap(version, (sourceVersion) =>
          outcome(exportArtifact({ body: { sourceVersion, gcsPath: MISSING_GCS } })),
        ),
        deleteFile: Effect.flatMap(file, (f) => deleteFile({ file: f })),
        deleteVersion: Effect.flatten(
          params((p) => deleteVersion({ package: p.package!, version: p.version!, force: true })),
        ),
        // `?version=` is a version's full name.
        batchDeleteVersions: Effect.flatten(
          params((p) =>
            batchDeleteVersions({ package: p.package!, body: { names: [p.version!] } }),
          ),
        ),
        deletePackage: Effect.flatMap(pkg, (p) => deletePackage({ package: p })),

        formats: Effect.all({
          maven: listMaven(),
          mavenMissing: outcome(getMaven({ mavenArtifact: "com.example:missing:1.0.0" })),
          npm: listNpm(),
          npmMissing: outcome(getNpm({ npmPackage: "missing:1.0.0" })),
          python: listPython(),
          pythonMissing: outcome(getPython({ pythonPackage: "missing:1.0.0" })),
        }),
        imports: Effect.all({
          apt: outcome(importApt({ body: { gcsSource: { uris: [MISSING_GCS] } } })),
          yum: outcome(importYum({ body: { gcsSource: { uris: [MISSING_GCS] } } })),
          googet: outcome(importGooget({ body: { gcsSource: { uris: [MISSING_GCS] } } })),
        }),
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.ArtifactRegistry.ListDockerImagesHttp,
        GCP.ArtifactRegistry.GetRepositoryHttp,
        GCP.ArtifactRegistry.ListRepositoryPackagesHttp,
        GCP.ArtifactRegistry.GetRepositoryPackageHttp,
        GCP.ArtifactRegistry.PatchRepositoryPackageHttp,
        GCP.ArtifactRegistry.DeleteRepositoryPackageHttp,
        GCP.ArtifactRegistry.ListRepositoryPackageVersionsHttp,
        GCP.ArtifactRegistry.GetRepositoryPackageVersionHttp,
        GCP.ArtifactRegistry.PatchRepositoryPackageVersionHttp,
        GCP.ArtifactRegistry.DeleteRepositoryPackageVersionHttp,
        GCP.ArtifactRegistry.BatchDeleteRepositoryPackageVersionsHttp,
        GCP.ArtifactRegistry.ListRepositoryPackageTagsHttp,
        GCP.ArtifactRegistry.GetRepositoryPackageTagHttp,
        GCP.ArtifactRegistry.CreateRepositoryPackageTagHttp,
        GCP.ArtifactRegistry.PatchRepositoryPackageTagHttp,
        GCP.ArtifactRegistry.DeleteRepositoryPackageTagHttp,
        GCP.ArtifactRegistry.ListRepositoryFilesHttp,
        GCP.ArtifactRegistry.GetRepositoryFileHttp,
        GCP.ArtifactRegistry.PatchRepositoryFileHttp,
        GCP.ArtifactRegistry.DownloadRepositoryFileHttp,
        GCP.ArtifactRegistry.DeleteRepositoryFileHttp,
        GCP.ArtifactRegistry.GetRepositoryDockerImageHttp,
        GCP.ArtifactRegistry.ListRepositoryRulesHttp,
        GCP.ArtifactRegistry.GetRepositoryRuleHttp,
        GCP.ArtifactRegistry.CreateRepositoryRuleHttp,
        GCP.ArtifactRegistry.PatchRepositoryRuleHttp,
        GCP.ArtifactRegistry.DeleteRepositoryRuleHttp,
        GCP.ArtifactRegistry.ListRepositoryAttachmentsHttp,
        GCP.ArtifactRegistry.GetRepositoryAttachmentHttp,
        GCP.ArtifactRegistry.CreateRepositoryAttachmentHttp,
        GCP.ArtifactRegistry.DeleteRepositoryAttachmentHttp,
        GCP.ArtifactRegistry.ExportRepositoryArtifactHttp,
        GCP.ArtifactRegistry.ListRepositoryMavenArtifactsHttp,
        GCP.ArtifactRegistry.GetRepositoryMavenArtifactHttp,
        GCP.ArtifactRegistry.ListRepositoryNpmPackagesHttp,
        GCP.ArtifactRegistry.GetRepositoryNpmPackageHttp,
        GCP.ArtifactRegistry.ListRepositoryPythonPackagesHttp,
        GCP.ArtifactRegistry.GetRepositoryPythonPackageHttp,
        GCP.ArtifactRegistry.ImportRepositoryAptArtifactHttp,
        GCP.ArtifactRegistry.ImportRepositoryYumArtifactHttp,
        GCP.ArtifactRegistry.ImportRepositoryGoogetArtifactHttp,
      ),
    ),
  ),
) {}
