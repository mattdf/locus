import type {
  AnnotationAnchorSnapshotSet,
  ChatTree,
  HighlightAnchor,
  ThreadNode,
} from "../types";
import { createPositionMapper, remapAnchor } from "./sourceEditing";

export type AssistantAnnotationKind =
  | "branch"
  | "definition"
  | "visualization"
  | "inline-elaboration";

export interface AssistantAnnotationRef {
  key: string;
  kind: AssistantAnnotationKind;
  id: string;
  anchor: HighlightAnchor;
}

export function annotationSnapshots(
  annotations: AssistantAnnotationRef[],
  anchors?: Map<string, HighlightAnchor>,
): AnnotationAnchorSnapshotSet {
  const snapshots: AnnotationAnchorSnapshotSet = {
    branches: [],
    definitions: [],
    visualizations: [],
    inlineElaborations: [],
  };
  annotations.forEach((annotation) => {
    const snapshot = {
      id: annotation.id,
      anchor: anchors?.get(annotation.key) ?? annotation.anchor,
    };
    if (annotation.kind === "branch") snapshots.branches.push(snapshot);
    else if (annotation.kind === "definition") snapshots.definitions.push(snapshot);
    else if (annotation.kind === "visualization") snapshots.visualizations.push(snapshot);
    else snapshots.inlineElaborations.push(snapshot);
  });
  return snapshots;
}

export function snapshotAnchorMap(
  snapshots: AnnotationAnchorSnapshotSet,
): Map<string, HighlightAnchor> {
  return new Map([
    ...snapshots.branches.map((item) => [`branch:${item.id}`, item.anchor] as const),
    ...snapshots.definitions.map((item) => [`definition:${item.id}`, item.anchor] as const),
    ...snapshots.visualizations.map((item) => [
      `visualization:${item.id}`,
      item.anchor,
    ] as const),
    ...snapshots.inlineElaborations.map((item) => [
      `inline-elaboration:${item.id}`,
      item.anchor,
    ] as const),
  ]);
}

/**
 * Reuses a target variant's saved anchors and diff-maps annotations created
 * after that variant was last active.
 */
export function materializeAnnotationSnapshots(
  annotations: AssistantAnnotationRef[],
  currentContent: string,
  targetContent: string,
  storedTarget: AnnotationAnchorSnapshotSet,
): AnnotationAnchorSnapshotSet {
  const storedAnchors = snapshotAnchorMap(storedTarget);
  const mapper = createPositionMapper(currentContent, targetContent);
  const anchors = new Map<string, HighlightAnchor>();
  annotations.forEach((annotation) => {
    anchors.set(
      annotation.key,
      storedAnchors.get(annotation.key) ??
        remapAnchor(currentContent, targetContent, annotation.anchor, mapper),
    );
  });
  return annotationSnapshots(annotations, anchors);
}

export function applyAnnotationSnapshots(
  chat: ChatTree,
  nodeId: string,
  snapshots: AnnotationAnchorSnapshotSet,
  updatedAt: string,
): { nodes: Record<string, ThreadNode>; node: ThreadNode } | null {
  const node = chat.nodes[nodeId];
  if (!node) return null;
  const branchAnchors = new Map(snapshots.branches.map((item) => [item.id, item.anchor]));
  const definitionAnchors = new Map(
    snapshots.definitions.map((item) => [item.id, item.anchor]),
  );
  const visualizationAnchors = new Map(
    snapshots.visualizations.map((item) => [item.id, item.anchor]),
  );
  const elaborationAnchors = new Map(
    snapshots.inlineElaborations.map((item) => [item.id, item.anchor]),
  );
  const nodes = Object.fromEntries(
    Object.entries(chat.nodes).map(([id, candidate]) => [
      id,
      branchAnchors.has(id)
        ? { ...candidate, anchor: branchAnchors.get(id), updatedAt }
        : candidate,
    ]),
  );
  const updatedNode: ThreadNode = {
    ...node,
    updatedAt,
    definitions: node.definitions?.map((definition) => ({
      ...definition,
      anchor: definitionAnchors.get(definition.id) ?? definition.anchor,
    })),
    visualizations: node.visualizations?.map((visualization) => ({
      ...visualization,
      anchor: visualizationAnchors.get(visualization.id) ?? visualization.anchor,
    })),
    inlineElaborations: node.inlineElaborations?.map((elaboration) => ({
      ...elaboration,
      anchor: elaborationAnchors.get(elaboration.id) ?? elaboration.anchor,
    })),
  };
  nodes[nodeId] = updatedNode;
  return { nodes, node: updatedNode };
}
