import React, { useEffect, useRef, useState, useCallback } from 'react';
import { describe, test, expect } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { requireSignupPassword } from './AppContext';

/**
 * Email signup sent an empty password, and blamed the user for it.
 *
 * Registration is split in two: the form takes email and password, then the
 * user picks Student or Shop Owner, and only then is the account created. The
 * password waits on a "pending user" in between, read back through a ref.
 *
 * The ref was written in a `useEffect`. React flushes a child's effects before
 * its parent's, so `LoginPage`'s effect — which reacts to the pending user and
 * immediately calls `completeStudentProfileCreation` — ran while the provider's
 * sync effect was still queued. It read the previous value, `null`.
 *
 * `|| ''` then turned that miss into an empty string, and the server answered
 * with all five password-strength errors at once about a password that had been
 * typed correctly. Nothing in that message pointed at the real fault.
 */

describe('The password survives the gap between the two signup steps', () => {
  test('a ref written in useEffect is still stale when the child reads it', async () => {
    // This is the original bug, reproduced with nothing but React's ordering.
    const readByChild: Array<string | null> = [];

    function Provider({ children }: { children: (set: (v: string) => void) => React.ReactNode }) {
      const [value, setValue] = useState<string | null>(null);
      const ref = useRef<string | null>(null);
      useEffect(() => { ref.current = value; }, [value]); // the old, too-late sync
      return <Child value={value} readRef={() => ref.current} setValue={setValue} render={children} />;
    }

    function Child({ value, readRef, setValue, render }: {
      value: string | null;
      readRef: () => string | null;
      setValue: (v: string) => void;
      render: (set: (v: string) => void) => React.ReactNode;
    }) {
      useEffect(() => {
        if (value !== null) readByChild.push(readRef());
      }, [value, readRef]);
      return <>{render(setValue)}</>;
    }

    let stash: ((v: string) => void) | null = null;
    render(<Provider>{(set) => { stash = set; return null; }}</Provider>);

    await waitFor(() => expect(stash).toBeTruthy());
    stash!('Str0ng#Pass');

    // The child ran first and saw nothing — exactly what registration saw.
    await waitFor(() => expect(readByChild).toHaveLength(1));
    expect(readByChild[0]).toBeNull();
  });

  test('writing the ref synchronously with the state makes it readable at once', async () => {
    // The fix. Same tree, same ordering — the ref is simply written eagerly.
    const readByChild: Array<string | null> = [];

    function Provider({ children }: { children: (set: (v: string) => void) => React.ReactNode }) {
      const [value, setValue] = useState<string | null>(null);
      const ref = useRef<string | null>(null);
      const set = useCallback((v: string) => {
        ref.current = v;   // synchronous
        setValue(v);
      }, []);
      return <Child value={value} readRef={() => ref.current} setValue={set} render={children} />;
    }

    function Child({ value, readRef, setValue, render }: {
      value: string | null;
      readRef: () => string | null;
      setValue: (v: string) => void;
      render: (set: (v: string) => void) => React.ReactNode;
    }) {
      useEffect(() => {
        if (value !== null) readByChild.push(readRef());
      }, [value, readRef]);
      return <>{render(setValue)}</>;
    }

    let stash: ((v: string) => void) | null = null;
    render(<Provider>{(set) => { stash = set; return null; }}</Provider>);

    await waitFor(() => expect(stash).toBeTruthy());
    stash!('Str0ng#Pass');

    await waitFor(() => expect(readByChild).toHaveLength(1));
    expect(readByChild[0]).toBe('Str0ng#Pass');
  });
});

describe('requireSignupPassword', () => {
  test('returns the password the user typed', () => {
    expect(requireSignupPassword({ _tempPassword: 'Str0ng#Pass' })).toBe('Str0ng#Pass');
  });

  test('throws rather than sending an empty password when the ref was stale', () => {
    // The old code sent `''` here. The server then reported five strength
    // failures for a password the user had entered correctly, which sent them
    // to fix something that was never wrong.
    expect(() => requireSignupPassword(null)).toThrow(/not carried through/i);
    expect(() => requireSignupPassword(undefined)).toThrow(/not carried through/i);
    expect(() => requireSignupPassword({})).toThrow(/not carried through/i);
  });

  test('an empty string counts as missing, not as a password', () => {
    expect(() => requireSignupPassword({ _tempPassword: '' })).toThrow(/not carried through/i);
  });

  test('the message names the step to retry, not the password rules', () => {
    // The failure is ours, so the instruction has to be one the user can act
    // on — re-enter it — rather than a lecture about uppercase letters.
    let message = '';
    try { requireSignupPassword(null); } catch (e) { message = (e as Error).message; }
    expect(message).not.toMatch(/uppercase|special character|8 characters/i);
    expect(message).toMatch(/enter it again/i);
  });
});
