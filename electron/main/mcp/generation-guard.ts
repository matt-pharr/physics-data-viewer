/**
 * generation-guard.ts — Predicate for bumping the MCP project/kernel
 * generation counter (ARCHITECTURE.md §15.3).
 *
 * The counter must bump only when the active project dir or kernel id
 * actually *changes from one set value to another or to null* — i.e. a real
 * project/kernel switch. The two cases that look like a "set" but aren't a
 * switch:
 *
 *   - initial `null -> X` at window startup (no agent has seen any state yet)
 *   - re-asserting the same value (`X -> X`), as `project:save` does on every
 *     save when it calls `setActiveProjectDir(saveDir)`
 *
 * Both must NOT bump, or any connected MCP agent will see a misleading
 * "PDV's project or kernel has changed since this MCP session connected.
 * Reconnect the MCP client to continue." error.
 *
 * This file holds the predicate as a pure function so it can be unit-tested
 * independent of the IPC closure that owns the mutable `activeProjectDir` /
 * `activeKernelId` state.
 */

/**
 * Returns true when transitioning `prev -> next` is a real switch that
 * should bump the MCP generation counter.
 *
 * A real switch requires `prev` to have been set (non-null) AND the new
 * value to differ from the old. `null -> X` (first set) and `X -> X`
 * (re-assertion, e.g. project:save) are both no-ops.
 *
 * @param prev - The previous value (`null` when never set in this session).
 * @param next - The value being assigned.
 * @returns Whether to call `bumpGeneration()`.
 */
export function shouldBumpOnSwap<T>(prev: T | null, next: T | null): boolean {
  return prev !== null && prev !== next;
}
