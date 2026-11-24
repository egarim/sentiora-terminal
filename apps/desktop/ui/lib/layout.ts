/**
 * The split-pane tree.
 *
 * Pure and framework-free on purpose: every transform returns a new tree, so
 * React sees a new reference and the layout is easy to reason about and to test.
 * A leaf owns exactly one session, and each leaf is fitted and resized
 * independently -- which is what makes per-pane resize (U03) work.
 */

export type SplitDirection = 'horizontal' | 'vertical';

export interface Leaf {
  type: 'leaf';
  leafId: string;
  sessionId: string;
}

export interface Split {
  type: 'split';
  splitId: string;
  /** 'horizontal' places children side by side; 'vertical' stacks them. */
  direction: SplitDirection;
  /** Fraction of the container given to `first`, 0..1. */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = Leaf | Split;

let leafCounter = 0;
let splitCounter = 0;

export function newLeafId(): string {
  leafCounter += 1;
  return `leaf-${leafCounter}`;
}

export function newSplitId(): string {
  splitCounter += 1;
  return `split-${splitCounter}`;
}

export function leaf(sessionId: string, leafId: string = newLeafId()): Leaf {
  return { type: 'leaf', leafId, sessionId };
}

export function split(direction: SplitDirection, first: LayoutNode, second: LayoutNode, ratio = 0.5): Split {
  return { type: 'split', splitId: newSplitId(), direction, ratio: clampRatio(ratio), first, second };
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  // Never allow a pane to be squeezed to nothing: an unfocusable zero-size pane
  // is a keyboard trap.
  return Math.min(0.9, Math.max(0.1, ratio));
}

export function isLeaf(node: LayoutNode): node is Leaf {
  return node.type === 'leaf';
}

export function leavesOf(node: LayoutNode | null): Leaf[] {
  if (!node) return [];
  if (isLeaf(node)) return [node];
  return [...leavesOf(node.first), ...leavesOf(node.second)];
}

export function findLeaf(node: LayoutNode | null, leafId: string): Leaf | null {
  for (const candidate of leavesOf(node)) {
    if (candidate.leafId === leafId) return candidate;
  }
  return null;
}

export function findSplit(node: LayoutNode | null, splitId: string): Split | null {
  if (!node || isLeaf(node)) return null;
  if (node.splitId === splitId) return node;
  return findSplit(node.first, splitId) ?? findSplit(node.second, splitId);
}

/** Replaces the leaf with a split of (leaf, newLeaf). */
export function insertSplit(node: LayoutNode, leafId: string, direction: SplitDirection, newSessionId: string): LayoutNode {
  if (isLeaf(node)) {
    if (node.leafId !== leafId) return node;
    return split(direction, node, leaf(newSessionId));
  }
  return {
    ...node,
    first: insertSplit(node.first, leafId, direction, newSessionId),
    second: insertSplit(node.second, leafId, direction, newSessionId),
  };
}

/** Removes a leaf and collapses its parent split. Returns null when the tree is empty. */
export function removeLeaf(node: LayoutNode | null, leafId: string): LayoutNode | null {
  if (!node) return null;
  if (isLeaf(node)) return node.leafId === leafId ? null : node;
  const first = removeLeaf(node.first, leafId);
  const second = removeLeaf(node.second, leafId);
  if (first && second) return { ...node, first, second };
  return first ?? second ?? null;
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (isLeaf(node)) return node;
  if (node.splitId === splitId) return { ...node, ratio: clampRatio(ratio) };
  return { ...node, first: setRatio(node.first, splitId, ratio), second: setRatio(node.second, splitId, ratio) };
}

/** The pane that would be focused next in a keyboard traversal order. */
export function leafIdsInOrder(node: LayoutNode | null): string[] {
  return leavesOf(node).map(entry => entry.leafId);
}
