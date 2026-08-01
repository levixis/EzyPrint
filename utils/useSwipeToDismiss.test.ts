import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSwipeToDismiss } from './useSwipeToDismiss';

/**
 * The failure mode a swipe list has to be tested against is not "the swipe
 * doesn't work" — it is "the swipe works so eagerly that the list can no longer
 * be scrolled". A row that reacts to any horizontal component turns an ordinary
 * vertical flick into a jittery half-swipe, which is the single most common
 * complaint about swipeable lists on Android.
 *
 * These tests drive the handlers directly. jsdom has no layout and no real
 * PointerEvent, so dispatching genuine events would test the shim rather than
 * the decision logic.
 */

const ROW_WIDTH = 300;

/** A pointer event stub carrying the fields the hook actually reads. */
function pointer(x: number, y: number, pointerId = 1) {
  return {
    pointerId,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y,
    currentTarget: {
      getBoundingClientRect: () => ({ width: ROW_WIDTH }),
      setPointerCapture: vi.fn(),
    },
  } as never;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Axis locking', () => {
  test('a vertical flick is left to the scroller', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      // Mostly down, with the slight sideways drift every real thumb has.
      result.current.handlers.onPointerMove(pointer(104, 140));
    });

    // The row must not have moved a single pixel, or the list stutters.
    expect(result.current.offset).toBe(0);
    expect(result.current.isSwiping).toBe(false);
  });

  test('once vertical, the row ignores the rest of the gesture', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(104, 140));
      // A finger curving sideways mid-scroll must not suddenly grab the row.
      result.current.handlers.onPointerMove(pointer(260, 150));
    });

    expect(result.current.offset).toBe(0);
  });

  test('an ambiguous diagonal goes to the scroller, not the row', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      // Exactly 45°. Reading a list is common, dismissing is rare, so a tie
      // must not cost the user their scroll.
      result.current.handlers.onPointerMove(pointer(130, 130));
    });

    expect(result.current.offset).toBe(0);
  });

  test('a clearly horizontal drag moves the row', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(160, 104));
    });

    expect(result.current.offset).toBe(60);
    expect(result.current.isSwiping).toBe(true);
  });

  test('tiny movement decides nothing — a tap is not a swipe', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(103, 101));
      result.current.handlers.onPointerUp(pointer(103, 101));
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });
});

describe('Dismiss thresholds', () => {
  test('a short slow drag springs back instead of dismissing', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(150, 100));
    });
    // Well past the axis lock but only ~17% across the row.
    act(() => {
      vi.advanceTimersByTime(600);
      result.current.handlers.onPointerUp(pointer(150, 100));
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });

  test('dragging most of the way across dismisses', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(250, 100));
      result.current.handlers.onPointerUp(pointer(250, 100));
    });

    // The row animates out before the row is actually removed.
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a cancelled gesture returns the row rather than dismissing it', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(250, 100));
      // An incoming call, or the system taking over the gesture.
      result.current.handlers.onPointerCancel();
    });

    act(() => { vi.advanceTimersByTime(300); });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });

  test('a disabled row never moves', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss, disabled: true }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100));
      result.current.handlers.onPointerMove(pointer(250, 100));
      result.current.handlers.onPointerUp(pointer(250, 100));
    });

    act(() => { vi.advanceTimersByTime(300); });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });

  test('a second finger does not hijack a swipe already in progress', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss({ onDismiss }));

    act(() => {
      result.current.handlers.onPointerDown(pointer(100, 100, 1));
      result.current.handlers.onPointerMove(pointer(160, 100, 1));
      // A second thumb landing elsewhere must be ignored outright.
      result.current.handlers.onPointerMove(pointer(20, 100, 2));
    });

    expect(result.current.offset).toBe(60);
  });
});
