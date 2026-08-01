import { describe, test, expect } from 'vitest';
import { formatDateTime, formatDate, toDate } from './datetime';

/**
 * `new Date(undefined).toLocaleString()` returns the literal string "Invalid
 * Date", and React renders it without complaint — so a field the server never
 * sent surfaces as those two words in the UI rather than as an error anyone
 * notices. A ticket message shipped timestamped exactly that way.
 */

describe('formatDateTime', () => {
  test('never renders the words "Invalid Date"', () => {
    for (const bad of [undefined, null, '', 'not-a-date', {}, [], NaN]) {
      expect(formatDateTime(bad)).not.toContain('Invalid');
    }
  });

  test('a missing timestamp leaves a gap rather than asserting a time', () => {
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime(null)).toBe('');
  });

  test('honours an explicit fallback', () => {
    expect(formatDateTime(undefined, 'just now')).toBe('just now');
  });

  test('formats a real ISO timestamp', () => {
    const out = formatDateTime('2026-08-01T10:33:00.000Z');
    expect(out).not.toBe('');
    expect(out).not.toContain('Invalid');
  });

  test('accepts a Date instance', () => {
    expect(formatDateTime(new Date('2026-08-01'))).not.toBe('');
  });
});

describe('toDate', () => {
  test('rejects a Date built from nonsense', () => {
    expect(toDate(new Date('nonsense'))).toBeNull();
  });

  test('rejects objects and arrays that String() would mangle', () => {
    expect(toDate({})).toBeNull();
    expect(toDate([])).toBeNull();
  });

  test('accepts epoch milliseconds', () => {
    expect(toDate(1754042000000)).toBeInstanceOf(Date);
  });
});

describe('formatDate', () => {
  test('degrades the same way', () => {
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('2026-08-01')).not.toContain('Invalid');
  });
});
