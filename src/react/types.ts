import type { SyncApi } from '../types';

/** Minimal database interface for React hooks */
export interface DyncLike {
    sync: Pick<SyncApi, 'state' | 'onStateChange' | 'onMutation'>;
}
