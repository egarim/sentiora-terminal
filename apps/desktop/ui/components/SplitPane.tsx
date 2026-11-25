import { useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { isLeaf, type LayoutNode, type Split } from '../lib/layout';

interface Props {
  node: LayoutNode;
  renderLeaf: (leafId: string) => ReactNode;
  onRatio: (splitId: string, ratio: number) => void;
}

const STEP = 0.05;
const FINE_STEP = 0.01;

/** Recursive split renderer. Leaves are delegated to the caller's renderer. */
export function SplitPane({ node, renderLeaf, onRatio }: Props) {
  if (isLeaf(node)) return <>{renderLeaf(node.leafId)}</>;
  return <SplitNode node={node} renderLeaf={renderLeaf} onRatio={onRatio} />;
}

/**
 * One split, with a divider that is a focusable `role="separator"`.
 *
 * It can be dragged with a pointer or adjusted with the keyboard, so pane sizing
 * is reachable without a mouse (U07). Each pane is fitted independently, which is
 * what makes per-pane resize (U03) real rather than one size for the whole window.
 *
 * Split out from SplitPane so the hooks below are never conditional: a node can
 * change between leaf and split as the user opens and closes panes.
 */
function SplitNode({ node, renderLeaf, onRatio }: { node: Split; renderLeaf: Props['renderLeaf']; onRatio: Props['onRatio'] }) {
  const horizontal = node.direction === 'horizontal';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const percent = Math.round(node.ratio * 100);

  const ratioFromPointer = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return node.ratio;
    const span = horizontal ? rect.width : rect.height;
    if (span <= 0) return node.ratio;
    const offset = horizontal ? clientX - rect.left : clientY - rect.top;
    return Math.min(0.9, Math.max(0.1, offset / span));
  }, [horizontal, node.ratio]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      onRatio(node.splitId, ratioFromPointer(moveEvent.clientX, moveEvent.clientY));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }, [node.splitId, onRatio, ratioFromPointer]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? FINE_STEP : STEP;
    // For a side-by-side split the divider is vertical, so left/right move it; for
    // a stacked split it is horizontal, so up/down do. Both are accepted in either
    // orientation because guessing wrong is worse than being slightly generous.
    const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const shrink = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (grow) onRatio(node.splitId, Math.min(0.9, node.ratio + step));
    else if (shrink) onRatio(node.splitId, Math.max(0.1, node.ratio - step));
    else if (event.key === 'Home') onRatio(node.splitId, 0.5);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, [node.ratio, node.splitId, onRatio]);

  const style = horizontal
    ? { gridTemplateColumns: `${percent}% 6px ${100 - percent}%` }
    : { gridTemplateRows: `${percent}% 6px ${100 - percent}%` };

  return (
    <div className={`split split--${node.direction}`} ref={containerRef} style={style}>
      <div className="split__cell">
        <SplitPane node={node.first} renderLeaf={renderLeaf} onRatio={onRatio} />
      </div>
      <div
        className="split__divider"
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={horizontal ? 'Resize side-by-side panes' : 'Resize stacked panes'}
        aria-valuenow={percent}
        aria-valuemin={10}
        aria-valuemax={90}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="split__cell">
        <SplitPane node={node.second} renderLeaf={renderLeaf} onRatio={onRatio} />
      </div>
    </div>
  );
}
