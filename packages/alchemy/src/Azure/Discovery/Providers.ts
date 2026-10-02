import * as Layer from "effect/Layer";
import { Bookshelf, BookshelfProvider } from "./Bookshelf.ts";
import {
  ChatModelDeployment,
  ChatModelDeploymentProvider,
} from "./ChatModelDeployment.ts";
import { NodePool, NodePoolProvider } from "./NodePool.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { StorageAsset, StorageAssetProvider } from "./StorageAsset.ts";
import {
  StorageContainer,
  StorageContainerProvider,
} from "./StorageContainer.ts";
import { Supercomputer, SupercomputerProvider } from "./Supercomputer.ts";
import { Tool, ToolProvider } from "./Tool.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  Bookshelf,
  ChatModelDeployment,
  NodePool,
  Project,
  StorageAsset,
  StorageContainer,
  Supercomputer,
  Tool,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    BookshelfProvider(),
    ChatModelDeploymentProvider(),
    NodePoolProvider(),
    ProjectProvider(),
    StorageAssetProvider(),
    StorageContainerProvider(),
    SupercomputerProvider(),
    ToolProvider(),
    WorkspaceProvider(),
  );
