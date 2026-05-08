/**
 * hook-helpers.ts — Convenience helpers for renderHook tests of App-level hooks.
 *
 * Wraps `@testing-library/react`'s `renderHook` so that `window.pdv` is
 * always installed before the hook executes. Tests pass overrides via the
 * `pdvOverrides` option to swap in test-specific implementations.
 */

import { renderHook, type RenderHookResult } from "@testing-library/react";
import { installPdvMock, type PdvMock, type PdvMockOverrides } from "./pdv-mock";

export interface RenderHookWithPdvOptions<TProps> {
  /** Initial hook props. */
  initialProps?: TProps;
  /** Overrides applied to the typed `window.pdv` mock before the hook runs. */
  pdvOverrides?: PdvMockOverrides;
}

export interface RenderHookWithPdvResult<TResult, TProps>
  extends RenderHookResult<TResult, TProps> {
  /** The mock object installed at `window.pdv`. */
  pdv: PdvMock;
}

/**
 * Render a hook with `window.pdv` pre-installed and typed.
 *
 * @example
 * ```ts
 * const { result, pdv } = renderHookWithPdv(
 *   () => useFoo(),
 *   { pdvOverrides: { tree: { list: vi.fn(async () => fixtureNodes) } } },
 * );
 * await act(async () => { await vi.advanceTimersByTimeAsync(500); });
 * expect(pdv.codeCells.save).toHaveBeenCalledOnce();
 * ```
 */
export function renderHookWithPdv<TResult, TProps = unknown>(
  hook: (props: TProps) => TResult,
  options: RenderHookWithPdvOptions<TProps> = {},
): RenderHookWithPdvResult<TResult, TProps> {
  const pdv = installPdvMock(options.pdvOverrides);
  const rendered = renderHook(hook, {
    initialProps: options.initialProps,
  });
  return Object.assign(rendered, { pdv });
}
