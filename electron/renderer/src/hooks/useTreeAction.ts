/**
 * useTreeAction — shared handler for tree context menu actions that follow
 * the pattern: call API → setLastError on failure / bump tree refresh on
 * success → close the dialog.
 */

import { useCallback } from 'react';

interface UseTreeActionOptions {
  setLastError: (error: string | undefined) => void;
  setTreeRefreshToken: (fn: (t: number) => number) => void;
}

/**
 * Returns a wrapper that executes an async tree API call and handles the
 * common success/error/refresh boilerplate.
 */
export function useTreeAction({ setLastError, setTreeRefreshToken }: UseTreeActionOptions) {
  return useCallback(
    async <T extends { success: boolean; error?: string }>(
      apiCall: () => Promise<T>,
      close: () => void,
    ) => {
      try {
        const result = await apiCall();
        if (!result.success) {
          setLastError(result.error);
        } else {
          setTreeRefreshToken((t) => t + 1);
        }
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error));
      } finally {
        close();
      }
    },
    [setLastError, setTreeRefreshToken],
  );
}
