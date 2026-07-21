/**
 * useTreeAction — shared handler for tree context menu actions that follow
 * the pattern: call API → setLastError on failure / invalidate the tree
 * cache on success → close the dialog.
 */

import { useCallback } from 'react';
import { invalidateTree } from '../queries/invalidation';

interface UseTreeActionOptions {
  setLastError: (error: string | undefined) => void;
  /** Active kernel whose tree cache is invalidated on success. */
  kernelId: string | null;
}

/**
 * Returns a wrapper that executes an async tree API call and handles the
 * common success/error/refresh boilerplate.
 */
export function useTreeAction({ setLastError, kernelId }: UseTreeActionOptions) {
  return useCallback(
    async <T extends { success: boolean; error?: string }>(
      apiCall: () => Promise<T>,
      close: () => void,
    ) => {
      try {
        const result = await apiCall();
        if (!result.success) {
          setLastError(result.error);
        } else if (kernelId) {
          invalidateTree(kernelId);
        }
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error));
      } finally {
        close();
      }
    },
    [setLastError, kernelId],
  );
}
