// error-text.ts — one way to turn an unknown thrown value into log text.
//
// The codebase catches errors in a dozen places to keep the UI alive (a
// clipboard write, a toast, a file read). Every one of those catches needs
// the same thing: a short human-readable string. Doing it inline meant
// eighteen copies of `e instanceof Error ? e.message : String(e)` — and the
// `String(e)` arm is only reachable when something throws a non-Error (a
// rejected string, a thrown object), which no test ever exercised.
//
// One helper, one behaviour, one place to test it.
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
