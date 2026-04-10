/**
 * errors.ts — Shared error handling utilities for renderer components.
 */

/**
 * Build a `(error: unknown) => void` reporter that forwards a stringified
 * error message to the supplied callback. Used to bridge promise rejections
 * (`.catch(captureError)`) into a UI-level error sink.
 */
export function captureError(
  onError: (message: string) => void
): (error: unknown) => void {
  return (error: unknown): void => {
    onError(error instanceof Error ? error.message : String(error));
  };
}
