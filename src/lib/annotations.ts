import type {
  AnnotationAnchorSnapshotSet,
  AnnotationKind,
  AnnotationTarget,
  ChatTree,
  HighlightAnchor,
  SourceAnchorSnapshot,
  ThreadNode,
} from "../types";

const snapshotKey: Record<AnnotationKind, keyof AnnotationAnchorSnapshotSet> = {
  branch: "branches",
  definition: "definitions",
  visualization: "visualizations",
  "inline-elaboration": "inlineElaborations",
};

export function annotationAnchor(
  chat: ChatTree,
  nodeId: string,
  target: AnnotationTarget,
): HighlightAnchor | null {
  const node = chat.nodes[nodeId];
  if (!node) return null;
  if (target.kind === "branch") {
    const branch = chat.nodes[target.id];
    return branch?.parentId === nodeId ? branch.anchor ?? null : null;
  }
  if (target.kind === "definition") {
    return node.definitions?.find((item) => item.id === target.id)?.anchor ?? null;
  }
  if (target.kind === "visualization") {
    return node.visualizations?.find((item) => item.id === target.id)?.anchor ?? null;
  }
  return node.inlineElaborations?.find((item) => item.id === target.id)?.anchor ?? null;
}

function movedSnapshots(
  snapshots: AnnotationAnchorSnapshotSet,
  target: AnnotationTarget,
  anchor: HighlightAnchor,
): AnnotationAnchorSnapshotSet {
  const key = snapshotKey[target.kind];
  const current = snapshots[key];
  const replacement: SourceAnchorSnapshot = { id: target.id, anchor };
  const found = current.some((item) => item.id === target.id);
  return {
    ...snapshots,
    [key]: found
      ? current.map((item) => item.id === target.id ? replacement : item)
      : [...current, replacement],
  };
}

function moveWithinNode(
  node: ThreadNode,
  target: AnnotationTarget,
  anchor: HighlightAnchor,
  updatedAt: string,
): ThreadNode {
  const base: ThreadNode = {
    ...node,
    updatedAt,
    sourceEditUndo:
      node.sourceEditUndo?.sourceMessageId === anchor.sourceMessageId
        ? undefined
        : node.sourceEditUndo,
  };
  if (target.kind === "definition") {
    return {
      ...base,
      definitions: node.definitions?.map((item) =>
        item.id === target.id ? { ...item, anchor } : item,
      ),
    };
  }
  if (target.kind === "visualization") {
    return {
      ...base,
      visualizations: node.visualizations?.map((item) =>
        item.id === target.id ? { ...item, anchor, updatedAt } : item,
      ),
    };
  }
  if (target.kind === "inline-elaboration") {
    return {
      ...base,
      inlineElaborations: node.inlineElaborations?.map((item) =>
        item.id === target.id ? { ...item, anchor, updatedAt } : item,
      ),
    };
  }
  return base;
}

/** Moves one logical annotation without changing its generated content. */
export function moveAnnotation(
  chat: ChatTree,
  nodeId: string,
  target: AnnotationTarget,
  anchor: HighlightAnchor,
  updatedAt: string,
): ChatTree {
  const currentAnchor = annotationAnchor(chat, nodeId, target);
  const node = chat.nodes[nodeId];
  if (!node || !currentAnchor) return chat;
  if (
    anchor.sourceNodeId !== nodeId ||
    anchor.sourceMessageId !== currentAnchor.sourceMessageId
  ) {
    return chat;
  }

  const nodes = { ...chat.nodes };
  let movedNode = moveWithinNode(node, target, anchor, updatedAt);
  if (target.kind === "branch") {
    const branch = nodes[target.id];
    if (!branch || branch.parentId !== nodeId) return chat;
    nodes[target.id] = { ...branch, anchor, updatedAt };
  }

  const editGroup = movedNode.assistantEdits?.[anchor.sourceMessageId];
  if (editGroup) {
    movedNode = {
      ...movedNode,
      assistantEdits: {
        ...movedNode.assistantEdits,
        [anchor.sourceMessageId]: {
          ...editGroup,
          variants: editGroup.variants.map((variant) =>
            variant.id === editGroup.activeVariantId
              ? { ...variant, anchors: movedSnapshots(variant.anchors, target, anchor) }
              : variant,
          ),
        },
      },
    };
  }

  nodes[nodeId] = movedNode;
  return { ...chat, nodes, updatedAt };
}
