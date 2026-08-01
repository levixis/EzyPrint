import type React from 'react';
import { useCallback, useRef, useState } from 'react';

/**
 * Horizontal swipe-to-dismiss for a list row.
 *
 * Built on Pointer Events rather than Touch Events so the same code path serves
 * touch, mouse and stylus, and so `setPointerCapture` keeps delivering moves
 * when the finger leaves the element — without capture, a fast swipe drops its
 * own pointerup and the row sticks half-open.
 *
 * The two behaviours that make a swipe list feel wrong on Android, and what is
 * done about each:
 *
 *  - **Stealing the vertical scroll.** A list row that reacts to any horizontal
 *    component turns an ordinary flick-scroll into a jittery half-swipe. The
 *    gesture is therefore axis-locked on the first few pixels of movement: if
 *    the finger is travelling more vertically than horizontally, this row bows
 *    out for the rest of the gesture and lets the scroller have it.
 *
 *  - **Fighting the browser.** Once the row is tracking horizontally it calls
 *    preventDefault, which requires the listeners to be non-passive; React's
 *    JSX handlers are attached passively for touch-adjacent events, so the
 *    element sets `touch-action: pan-y` and lets the compositor enforce it
 *    instead. Vertical panning stays on the compositor thread and stays smooth.
 */

/** Fraction of the row's width a swipe must cross to count as a dismiss. */
const DISMISS_RATIO = 0.35;
/** Or this velocity, so a short fast flick also counts. px/ms. */
const DISMISS_VELOCITY = 0.5;
/** Movement before the axis is decided. */
const AXIS_LOCK_THRESHOLD = 8;

type Axis = 'undecided' | 'horizontal' | 'vertical';

export interface SwipeToDismissOptions {
  onDismiss: () => void;
  /** Disable the gesture (e.g. the row is already gone). */
  disabled?: boolean;
}

export function useSwipeToDismiss({ onDismiss, disabled }: SwipeToDismissOptions) {
  const [offset, setOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  const startX = useRef(0);
  const startY = useRef(0);
  const startTime = useRef(0);
  const axis = useRef<Axis>('undecided');
  const pointerId = useRef<number | null>(null);
  const width = useRef(1);

  const reset = useCallback(() => {
    setOffset(0);
    setIsSwiping(false);
    axis.current = 'undecided';
    pointerId.current = null;
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    // Ignore secondary mouse buttons; a right-click is not a swipe.
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    pointerId.current = event.pointerId;
    startX.current = event.clientX;
    startY.current = event.clientY;
    startTime.current = performance.now();
    axis.current = 'undecided';
    width.current = event.currentTarget.getBoundingClientRect().width || 1;
  }, [disabled]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (disabled || pointerId.current !== event.pointerId) return;

    const deltaX = event.clientX - startX.current;
    const deltaY = event.clientY - startY.current;

    if (axis.current === 'undecided') {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absX < AXIS_LOCK_THRESHOLD && absY < AXIS_LOCK_THRESHOLD) return;

      // Ties go to the scroller. Reading a list is the common action; dismissing
      // is the rare one, and stealing an ambiguous gesture from scrolling is far
      // more annoying than missing an ambiguous swipe.
      axis.current = absX > absY ? 'horizontal' : 'vertical';

      if (axis.current === 'vertical') {
        pointerId.current = null;
        return;
      }

      // Capture only once this row owns the gesture, so a vertical flick is
      // never diverted away from the scroll container.
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsSwiping(true);
    }

    if (axis.current !== 'horizontal') return;
    setOffset(deltaX);
  }, [disabled]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (pointerId.current !== event.pointerId || axis.current !== 'horizontal') {
      reset();
      return;
    }

    const deltaX = event.clientX - startX.current;
    const elapsed = Math.max(1, performance.now() - startTime.current);
    const velocity = Math.abs(deltaX) / elapsed;

    const travelled = Math.abs(deltaX) / width.current;
    const shouldDismiss = travelled > DISMISS_RATIO || velocity > DISMISS_VELOCITY;

    if (shouldDismiss) {
      // Finish the journey off-screen in the direction of travel, then hand
      // over. Snapping out of existence under the finger reads as a glitch.
      setOffset(deltaX > 0 ? width.current : -width.current);
      setIsSwiping(false);
      pointerId.current = null;
      window.setTimeout(onDismiss, 180);
      return;
    }

    reset();
  }, [onDismiss, reset]);

  const onPointerCancel = useCallback(() => { reset(); }, [reset]);

  return {
    offset,
    isSwiping,
    /** Spread onto the swipeable element. */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    /** Style for the moving layer. */
    style: {
      transform: `translate3d(${offset}px, 0, 0)`,
      // No transition while the finger is down — the row must track it exactly.
      transition: isSwiping ? 'none' : 'transform 180ms ease-out, opacity 180ms ease-out',
      opacity: 1 - Math.min(0.75, Math.abs(offset) / (width.current || 1)),
      // Lets the browser keep vertical panning on the compositor while this
      // element handles the horizontal axis itself.
      touchAction: 'pan-y' as const,
    },
  };
}
