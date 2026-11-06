// protocol.test.ts — the exhaustiveness guard.
//
// `assertNever` is the compile-time safety net for the message-router
// switches: a new union member without a matching case fails `tsc`. The
// runtime half — actually throwing — is what a broken build (or a message
// that escaped the union) hits at runtime.
import { describe, it, expect } from 'vitest';
import { assertNever } from '../src/shared/protocol';

describe('assertNever', () => {
  it('throws with the offending value', () => {
    expect(() => assertNever({ type: 'nope' } as never)).toThrow(/Unhandled protocol message/);
    expect(() => assertNever({ type: 'nope' } as never)).toThrow(/nope/);
  });
});
