import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { SyncState } from '../types';
import type { DyncLike } from './types';

/**
 * React hook that subscribes to Dync sync state changes.
 * Returns the current SyncState and re-renders when it changes.
 *
 * @param db - The Dync database instance
 * @returns The current SyncState
 *
 * @example
 * ```tsx
 * import { db } from './store';
 * import { useSyncState } from '@anfenn/dync/react';
 *
 * function SyncStatus() {
 *   const syncState = useSyncState(db);
 *   return <div>Status: {syncState.status}</div>;
 * }
 * ```
 */
export function useSyncState(db: DyncLike): SyncState {
    // Use refs to create stable subscribe/getSnapshot functions
    const cacheRef = useRef<SyncState>(db.sync.state);

    const subscribe = useCallback(
        (listener: () => void) =>
            db.sync.onStateChange((nextState) => {
                cacheRef.current = nextState;
                listener();
            }),
        [db],
    );

    const getSnapshot = useCallback(() => {
        const fresh = db.sync.state;
        if (JSON.stringify(fresh) !== JSON.stringify(cacheRef.current)) {
            cacheRef.current = fresh;
        }
        return cacheRef.current;
    }, [db]);

    return useSyncExternalStore<SyncState>(subscribe, getSnapshot, getSnapshot);
}
