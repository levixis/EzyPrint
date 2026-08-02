import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './Modal';
import { dismissTopOverlay, hasOpenOverlay, useBackDismiss } from '../../utils/backGesture';

/**
 * Order detail, shop settings and the OTP prompts are all modals over a
 * dashboard — there is no AppView for any of them. So the view-level back
 * handler saw 'shopDashboard' while an order was open, treated it as a root
 * view, and minimised the app. Back out of an order and the app vanished.
 *
 * Registering the modal itself is what makes the gesture close it. These tests
 * pin that registration to the open/closed state.
 */

beforeEach(() => {
  while (dismissTopOverlay()) { /* empty */ }
});

describe('Modal registers for the Android back gesture', () => {
  test('a closed modal leaves the gesture to the view handler', () => {
    render(<Modal isOpen={false} onClose={() => { }}>body</Modal>);

    expect(hasOpenOverlay()).toBe(false);
  });

  test('an open modal consumes the gesture and closes', () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose}>body</Modal>);

    expect(dismissTopOverlay()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('closing the modal deregisters it', () => {
    const { rerender } = render(<Modal isOpen onClose={() => { }}>body</Modal>);
    rerender(<Modal isOpen={false} onClose={() => { }}>body</Modal>);

    // The modal animates out over 300ms and stays mounted for it. Staying
    // registered through that window would spend the next back press closing
    // something already on its way off screen.
    expect(hasOpenOverlay()).toBe(false);
  });

  test('unmounting an open modal deregisters it', () => {
    const { unmount } = render(<Modal isOpen onClose={() => { }}>body</Modal>);
    unmount();

    expect(hasOpenOverlay()).toBe(false);
  });

  test('a modal over the notification panel closes first', () => {
    const closePanel = vi.fn();
    const closeModal = vi.fn();

    const Panel = () => {
      useBackDismiss(true, closePanel);
      return null;
    };

    render(
      <>
        <Panel />
        <Modal isOpen onClose={closeModal}>body</Modal>
      </>
    );

    dismissTopOverlay();
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();
  });
});

describe('useBackDismiss tolerates an unstable callback', () => {
  test('re-rendering with a new arrow does not reorder the stack', () => {
    const closePanel = vi.fn();
    const closeModal = vi.fn();

    // The panel registers first and must stay underneath. Every caller passes
    // an inline arrow, so re-registering on callback identity would pop and
    // re-push the panel on each render and put it on top of the modal.
    const Panel = () => {
      useBackDismiss(true, () => closePanel());
      return null;
    };
    const Harness = () => {
      const [, force] = useState(0);
      return (
        <>
          <Panel />
          <Modal isOpen onClose={() => closeModal()}>body</Modal>
          <button onClick={() => force(n => n + 1)}>rerender</button>
        </>
      );
    };

    const { rerender } = render(<Harness />);
    rerender(<Harness />);
    rerender(<Harness />);

    dismissTopOverlay();
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();
  });

  test('the latest callback runs, not the one captured at registration', () => {
    const stale = vi.fn();
    const fresh = vi.fn();

    const Panel = ({ onDismiss }: { onDismiss: () => void }) => {
      useBackDismiss(true, onDismiss);
      return null;
    };

    const { rerender } = render(<Panel onDismiss={stale} />);
    rerender(<Panel onDismiss={fresh} />);

    dismissTopOverlay();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});
