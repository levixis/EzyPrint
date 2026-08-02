import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useAndroidBackButton } from './useAndroidBackButton';
import { pushDismissHandler, dismissTopOverlay } from './backGesture';
import { AppView } from '../types';

/**
 * The listener-leak regression.
 *
 * The handler used to be registered by an effect keyed on currentView, with its
 * removal function assigned two promises deep (dynamic import, then
 * addListener). A navigation that landed before those resolved ran a cleanup
 * that had nothing to remove, and the listener stayed attached. Capacitor
 * notifies every registered listener, so the stale one kept firing with the
 * view it captured — a single press navigated back on the live listener and
 * minimised the app on the stale one.
 *
 * The mock below models that faithfully: addListener resolves only when the
 * test says so, every live handler fires on a back press, and remove()
 * unregisters exactly one.
 */

const mocks = vi.hoisted(() => {
  const liveHandlers: { handler: () => void }[] = [];
  const pendingResolvers: (() => void)[] = [];
  const removeCalls = { count: 0 };
  const minimizeApp = vi.fn();
  const isNativePlatform = vi.fn(() => true);

  // Deferred only where a test needs to unmount mid-attach; otherwise the
  // handle resolves straight away, so settling is just draining microtasks.
  const defer = { enabled: false };

  const addListener = vi.fn((_event: string, handler: () => void) => {
    const entry = { handler };
    liveHandlers.push(entry);
    const handle = {
      remove: () => {
        removeCalls.count += 1;
        const index = liveHandlers.indexOf(entry);
        if (index !== -1) liveHandlers.splice(index, 1);
      },
    };
    if (!defer.enabled) return Promise.resolve(handle);
    return new Promise<typeof handle>(resolve => {
      pendingResolvers.push(() => resolve(handle));
    });
  });

  return { defer, liveHandlers, pendingResolvers, removeCalls, minimizeApp, isNativePlatform, addListener };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: mocks.isNativePlatform },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: mocks.addListener, minimizeApp: mocks.minimizeApp },
}));

/**
 * Let the dynamic import and the addListener promise settle.
 *
 * Two hops, and the second resolver only exists once the first has run — so
 * this drains repeatedly rather than flushing once. A single flush leaves
 * addListener's promise pending and silently skips the handle callback, which
 * is where the removal is wired up.
 */
const settleRegistration = async () => {
  // Two promise hops (dynamic import, then addListener), and under StrictMode
  // two such chains in flight. Vitest's mocked dynamic import takes several
  // turns to settle, so this drains generously rather than trying to detect
  // quiescence — bailing on the first quiet pass left a chain pending and
  // looked exactly like a lost listener.
  for (let pass = 0; pass < 20; pass += 1) {
    await act(async () => {
      mocks.pendingResolvers.splice(0).forEach(resolve => resolve());
    });
  }
};

/** What Capacitor does on a back press: notify every live listener. */
const pressBack = () => {
  act(() => {
    mocks.liveHandlers.slice().forEach(entry => entry.handler());
  });
};

const Harness = ({ view, goBack }: { view: AppView; goBack: () => boolean }) => {
  useAndroidBackButton(view, goBack);
  return null;
};

beforeEach(() => {
  mocks.liveHandlers.length = 0;
  mocks.pendingResolvers.length = 0;
  mocks.removeCalls.count = 0;
  mocks.addListener.mockClear();
  mocks.minimizeApp.mockClear();
  mocks.isNativePlatform.mockReturnValue(true);
  mocks.defer.enabled = false;
  while (dismissTopOverlay()) { /* empty */ }
});

describe('Android back listener registration', () => {
  test('a burst of navigations before the listener attaches registers it once', async () => {
    const goBack = vi.fn(() => true);

    // Three navigations land while the dynamic import is still in flight —
    // the exact window the old effect leaked in.
    const { rerender } = render(<Harness view="studentDashboard" goBack={goBack} />);
    rerender(<Harness view="getPass" goBack={goBack} />);
    rerender(<Harness view="privacy" goBack={goBack} />);

    await settleRegistration();

    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.liveHandlers).toHaveLength(1);
  });

  test('one press does not both navigate and minimise', async () => {
    const goBack = vi.fn(() => true);

    // Registered on a root view, then navigated away before it attached. A
    // leaked listener would still hold 'studentDashboard' and minimise, while
    // the live one navigates — the symptom the user reported.
    const { rerender } = render(<Harness view="studentDashboard" goBack={goBack} />);
    rerender(<Harness view="getPass" goBack={goBack} />);

    await settleRegistration();
    pressBack();

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(mocks.minimizeApp).not.toHaveBeenCalled();
  });

  test('steady-state navigation never accumulates listeners', async () => {
    const goBack = vi.fn(() => true);
    const views: AppView[] = ['studentDashboard', 'getPass', 'privacy', 'terms', 'contact', 'studentDashboard'];

    const { rerender } = render(<Harness view={views[0]} goBack={goBack} />);
    await settleRegistration();

    for (const view of views.slice(1)) {
      rerender(<Harness view={view} goBack={goBack} />);
      await settleRegistration();
    }

    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.liveHandlers).toHaveLength(1);
  });

  test('the listener reads the current view, not the one it captured', async () => {
    const goBack = vi.fn(() => true);

    const { rerender } = render(<Harness view="getPass" goBack={goBack} />);
    await settleRegistration();

    // Back on a root view leaves the app; the listener must see the move.
    rerender(<Harness view="studentDashboard" goBack={goBack} />);
    pressBack();

    expect(mocks.minimizeApp).toHaveBeenCalledTimes(1);
    expect(goBack).not.toHaveBeenCalled();
  });

  test('the listener calls the current goBack, not the one it captured', async () => {
    const stale = vi.fn(() => true);
    const fresh = vi.fn(() => true);

    const { rerender } = render(<Harness view="getPass" goBack={stale} />);
    await settleRegistration();
    rerender(<Harness view="getPass" goBack={fresh} />);

    pressBack();

    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  test('unmounting while the listener is still attaching still removes it', async () => {
    const goBack = vi.fn(() => true);

    mocks.defer.enabled = true;
    const { unmount } = render(<Harness view="studentDashboard" goBack={goBack} />);
    unmount();

    // Resolves only after the cleanup has already run — the window the
    // cancelled flag exists to cover.
    await settleRegistration();

    expect(mocks.removeCalls.count).toBe(1);
    expect(mocks.liveHandlers).toHaveLength(0);
  });

  test('an open overlay takes the press before navigation does', async () => {
    const goBack = vi.fn(() => true);
    const closeOverlay = vi.fn();

    render(<Harness view="getPass" goBack={goBack} />);
    await settleRegistration();
    pushDismissHandler(closeOverlay);

    pressBack();

    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(goBack).not.toHaveBeenCalled();
    expect(mocks.minimizeApp).not.toHaveBeenCalled();
  });

  test('a non-root view with empty history minimises rather than freezing', async () => {
    const goBack = vi.fn(() => false);

    render(<Harness view="privacy" goBack={goBack} />);
    await settleRegistration();
    pressBack();

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(mocks.minimizeApp).toHaveBeenCalledTimes(1);
  });

  test('nothing is registered on the web build', async () => {
    mocks.isNativePlatform.mockReturnValue(false);
    const goBack = vi.fn(() => true);

    render(<Harness view="studentDashboard" goBack={goBack} />);
    await settleRegistration();

    expect(mocks.addListener).not.toHaveBeenCalled();
  });
});
