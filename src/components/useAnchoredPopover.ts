import { type RefObject, useEffect, useState } from "react";
import type { SelectionDraft } from "../types";

type AnchorRect = SelectionDraft["rect"];

interface AnchoredPopoverOptions {
  anchorRect: AnchorRect;
  getAnchorRect?: () => AnchorRect;
  popoverRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  gap?: number;
  margin?: number;
}

function hasArea(rect: AnchorRect): boolean {
  return Boolean(rect.width || rect.height);
}

function isOutsideViewport(rect: AnchorRect, margin: number): boolean {
  return (
    rect.left + rect.width < -margin ||
    rect.left > window.innerWidth + margin ||
    rect.top + rect.height < -margin ||
    rect.top > window.innerHeight + margin
  );
}

/**
 * Keeps a fixed-position popover beside a DOM-backed annotation as its scroll
 * container moves. A tap outside dismisses it; a scroll gesture never does.
 */
export function useAnchoredPopover({
  anchorRect,
  getAnchorRect,
  popoverRef,
  onDismiss,
  gap = 10,
  margin = 12,
}: AnchoredPopoverOptions) {
  const [currentAnchor, setCurrentAnchor] = useState(anchorRect);
  const [position, setPosition] = useState({
    left: anchorRect.left,
    top: anchorRect.top + anchorRect.height + gap,
  });

  useEffect(() => setCurrentAnchor(anchorRect), [anchorRect]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;

    const place = () => {
      const bounds = popover.getBoundingClientRect();
      const left = Math.min(
        window.innerWidth - bounds.width - margin,
        Math.max(
          margin,
          currentAnchor.left + currentAnchor.width / 2 - bounds.width / 2,
        ),
      );
      const below = currentAnchor.top + currentAnchor.height + gap;
      const preferredTop =
        below + bounds.height <= window.innerHeight - margin
          ? below
          : currentAnchor.top - bounds.height - gap;
      const top = Math.min(
        window.innerHeight - bounds.height - margin,
        Math.max(margin, preferredTop),
      );
      setPosition({ left, top });
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(popover);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [currentAnchor, gap, margin, popoverRef]);

  useEffect(() => {
    const dismissOnClick = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    const dismissOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    let frame = 0;
    const reanchor = (event?: Event) => {
      if (
        event?.target instanceof Node &&
        popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      if (!getAnchorRect || frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const nextRect = getAnchorRect();
        if (!hasArea(nextRect)) return;
        if (isOutsideViewport(nextRect, margin)) {
          onDismiss();
          return;
        }
        setCurrentAnchor(nextRect);
      });
    };

    // `click` is intentional: touch scrolling does not emit it, while a tap on
    // the page does. Pointer-down dismissal would close the box at the start of
    // every mobile scroll gesture.
    document.addEventListener("click", dismissOnClick, true);
    document.addEventListener("keydown", dismissOnKey);
    document.addEventListener("scroll", reanchor, true);
    window.addEventListener("resize", reanchor);
    window.visualViewport?.addEventListener("scroll", reanchor);
    window.visualViewport?.addEventListener("resize", reanchor);
    return () => {
      document.removeEventListener("click", dismissOnClick, true);
      document.removeEventListener("keydown", dismissOnKey);
      document.removeEventListener("scroll", reanchor, true);
      window.removeEventListener("resize", reanchor);
      window.visualViewport?.removeEventListener("scroll", reanchor);
      window.visualViewport?.removeEventListener("resize", reanchor);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [getAnchorRect, margin, onDismiss, popoverRef]);

  return position;
}
