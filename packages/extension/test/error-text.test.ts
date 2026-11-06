// error-text.test.ts — the shared "what do I log?" helper.
//
// Eighteen catch blocks across the host needed the same thing, and each had
// its own inline copy of `e instanceof Error ? e.message : String(e)`. The
// non-Error arm is the interesting one: a harness can reject with a string or
// an object, and a log line that says "Error: [object Object]" helps nobody.
import { describe, it, expect } from 'vitest';
import { errorText } from '../src/host/error-text';

describe('errorText', () => {
  it('uses the message of an Error', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('uses the message of a subclass of Error', () => {
    class DomainError extends Error {}
    expect(errorText(new DomainError('nope'))).toBe('nope');
  });

  it('stringifies a thrown string', () => {
    expect(errorText('plain string')).toBe('plain string');
  });

  it('stringifies a thrown object', () => {
    expect(errorText({ code: 42 })).toBe('[object Object]');
  });

  it('stringifies null and undefined', () => {
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
  });
});
