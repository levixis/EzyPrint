import { useEffect } from 'react';

/**
 * A dismiss stack for the Android back gesture.
 *
 * Android's edge swipe and hardware back are one event, and the app has one
 * handler for it. Without somewhere to record "an overlay is open", that
 * handler can only change views — so swiping back with the notification panel
 * or a modal open blew straight past it and jumped a whole screen, leaving the
 * overlay hanging over the new view.
 *
 * Overlays push a dismiss function on mount and pop it on unmount. The back
 * handler takes the top of the stack first and only navigates once the stack
 * is empty, which is the behaviour every native Android app has.
 *
 * A module-level stack rather than context: overlays register from anywhere in
 * the tree, and re-rendering the whole app to open a dropdown is not worth it.
 */

type DismissFn = () => void;

const stack: { id: symbol; dismiss: DismissFn }[] = [];

/** Push a dismiss handler. Returns the function that removes it again. */
export function pushDismissHandler(dismiss: DismissFn): () => void {
  const entry = { id: Symbol('overlay'), dismiss };
  stack.push(entry);

  return () => {
    const index = stack.findIndex((candidate) => candidate.id === entry.id);
    if (index !== -1) stack.splice(index, 1);
  };
}

/**
 * Dismiss the topmost overlay.
 *
 * Returns true if something was dismissed, meaning the back press is spent and
 * the caller must not also navigate.
 */
export function dismissTopOverlay(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.dismiss();
  return true;
}

/** Whether anything is currently registered. */
export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

/**
 * Register an overlay for as long as it is open.
 *
 * `onDismiss` is read through a ref internally by way of the dependency list —
 * pass a stable callback, or accept that reopening the registration on every
 * render would reorder the stack.
 */
export function useBackDismiss(isOpen: boolean, onDismiss: DismissFn): void {
  useEffect(() => {
    if (!isOpen) return;
    return pushDismissHandler(onDismiss);
  }, [isOpen, onDismiss]);
}
