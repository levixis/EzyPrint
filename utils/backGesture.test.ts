import { describe, test, expect, vi, beforeEach } from 'vitest';
import { pushDismissHandler, dismissTopOverlay, hasOpenOverlay } from './backGesture';

/**
 * Android's edge swipe and hardware back are the same event, and the app has a
 * single handler for it. That handler could only change views, so swiping back
 * with the notification panel open navigated underneath it — the user lost a
 * whole screen and the panel stayed floating over a view it had nothing to do
 * with.
 *
 * The stack is what lets the handler spend the gesture on the overlay first.
 */

beforeEach(() => {
  // Drain anything a previous test left behind — the stack is module state.
  while (dismissTopOverlay()) { /* empty */ }
});

describe('Overlay dismiss stack', () => {
  test('with nothing open the gesture is not consumed', () => {
    // The caller must be free to navigate instead.
    expect(dismissTopOverlay()).toBe(false);
    expect(hasOpenOverlay()).toBe(false);
  });

  test('an open overlay consumes the gesture instead of navigating', () => {
    const close = vi.fn();
    pushDismissHandler(close);

    expect(dismissTopOverlay()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('the most recently opened overlay closes first', () => {
    const closePanel = vi.fn();
    const closeModal = vi.fn();
    pushDismissHandler(closePanel);
    pushDismissHandler(closeModal);

    // A modal opened on top of the panel is what the user sees, so it is what
    // "back" means.
    dismissTopOverlay();
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();

    dismissTopOverlay();
    expect(closePanel).toHaveBeenCalledTimes(1);
  });

  test('an overlay closed by tapping outside leaves nothing behind', () => {
    const close = vi.fn();
    const unregister = pushDismissHandler(close);

    unregister();

    // Otherwise the next back press would be swallowed closing something that
    // is already gone, and the user would have to press twice.
    expect(dismissTopOverlay()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  test('unregistering the middle of the stack does not disturb the rest', () => {
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    pushDismissHandler(first);
    const removeSecond = pushDismissHandler(second);
    pushDismissHandler(third);

    removeSecond();

    dismissTopOverlay();
    expect(third).toHaveBeenCalledTimes(1);
    dismissTopOverlay();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test('each overlay is dismissed once, even if two register the same function', () => {
    // Identity is per-registration, not per-callback — two panels sharing a
    // close handler must still take two back presses.
    const close = vi.fn();
    pushDismissHandler(close);
    pushDismissHandler(close);

    expect(dismissTopOverlay()).toBe(true);
    expect(dismissTopOverlay()).toBe(true);
    expect(dismissTopOverlay()).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
