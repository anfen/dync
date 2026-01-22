import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dync } from '../index';
import type { ApiFunctions, BatchSync, MutationEvent, SyncOptions, SyncState } from '../types';
import type { StorageAdapter } from '../storage/types';

export interface MakeDyncConfigPerTable {
    databaseName: string;
    syncApis: Record<string, ApiFunctions>;
    storageAdapter: StorageAdapter;
    options?: SyncOptions;
}

export interface MakeDyncConfigBatch {
    databaseName: string;
    batchSync: BatchSync;
    storageAdapter: StorageAdapter;
    options?: SyncOptions;
}

export type MakeDyncConfig = MakeDyncConfigPerTable | MakeDyncConfigBatch;

export interface UseDyncValue<TStoreMap extends Record<string, any>> {
    db: Dync<TStoreMap>;
    syncState: SyncState;
}

/**
 * A hook returned by makeDync that observes database queries and automatically
 * re-runs them when data changes. The db instance is passed to the querier callback.
 *
 * @param querier - Function that receives db and returns query result
 * @param deps - Optional React dependency list for re-running the query
 * @param tables - Optional array of table names to watch for mutations, otherwise it's all tables
 * @returns The query result, or undefined if not yet available
 */
export type BoundUseLiveQuery<TStoreMap extends Record<string, any>> = <T>(
    querier: (db: Dync<TStoreMap>) => Promise<T> | T,
    deps?: React.DependencyList,
    tables?: string[],
) => T | undefined;

export interface MakeDyncResult<TStoreMap extends Record<string, any>> {
    // The Dync database instance
    db: Dync<TStoreMap>;
    // Hook to get db and syncState in components
    useDync: () => UseDyncValue<TStoreMap>;
    // Hook for live queries - db is passed to the querier callback
    useLiveQuery: BoundUseLiveQuery<TStoreMap>;
}

export function makeDync<TStoreMap extends Record<string, any> = Record<string, unknown>>(config: MakeDyncConfig): MakeDyncResult<TStoreMap> {
    // Determine which mode based on config shape
    const db =
        'syncApis' in config
            ? new Dync<TStoreMap>(config.databaseName, config.syncApis, config.storageAdapter, config.options)
            : new Dync<TStoreMap>(config.databaseName, config.batchSync, config.storageAdapter, config.options);

    // Cache to provide referential stability (React requires stable references)
    // Updated when subscription fires OR when getSnapshot detects value changes
    let cachedState = db.sync.getState();

    const subscribe = (listener: () => void) =>
        db.sync.onStateChange((nextState) => {
            // Update cache immediately when notified, before React calls getSnapshot
            cachedState = nextState;
            listener();
        });

    // getSnapshot returns cached state, but also checks for changes that happened
    // before subscription was active (e.g., hydration during initial mount)
    const getSnapshot = () => {
        const fresh = db.sync.getState();
        if (JSON.stringify(fresh) !== JSON.stringify(cachedState)) {
            cachedState = fresh;
        }
        return cachedState;
    };

    const useDync = () => {
        const syncState = useSyncExternalStore<SyncState>(subscribe, getSnapshot, getSnapshot);
        return { db, syncState } as UseDyncValue<TStoreMap>;
    };

    // Create a bound useLiveQuery that passes db to the querier
    const boundUseLiveQuery: BoundUseLiveQuery<TStoreMap> = <T>(
        querier: (db: Dync<TStoreMap>) => Promise<T> | T,
        deps: React.DependencyList = [],
        tables?: string[],
    ): T | undefined => {
        return useLiveQueryImpl(db, querier, deps, tables);
    };

    return {
        db,
        useDync,
        useLiveQuery: boundUseLiveQuery,
    };
}

function useLiveQueryImpl<TStoreMap extends Record<string, any>, T>(
    db: Dync<TStoreMap>,
    querier: (db: Dync<TStoreMap>) => Promise<T> | T,
    deps: React.DependencyList = [],
    tables?: string[],
): T | undefined {
    const [result, setResult] = useState<T | undefined>(undefined);
    const [, setError] = useState<Error | null>(null);
    const isMountedRef = useRef(true);
    const queryVersionRef = useRef(0);
    const querierRef = useRef(querier);
    const tablesRef = useRef(tables);

    // Keep refs up to date
    querierRef.current = querier;
    tablesRef.current = tables;

    const runQuery = useCallback(async () => {
        const currentVersion = ++queryVersionRef.current;
        try {
            const queryResult = await querierRef.current(db);
            // Only update if still mounted and this is the latest query
            if (isMountedRef.current && currentVersion === queryVersionRef.current) {
                setResult(queryResult);
                setError(null);
            }
        } catch (err) {
            if (isMountedRef.current && currentVersion === queryVersionRef.current) {
                setError(err as Error);
            }
        }
    }, [db]);

    // Re-run query when deps change
    useEffect(() => {
        runQuery();
    }, [...deps, runQuery]);

    useEffect(() => {
        isMountedRef.current = true;

        // Subscribe to mutation events
        const unsubscribe = db.sync.onMutation((event: MutationEvent) => {
            // Only re-run if no tables filter specified, or if the mutation affects a watched table
            if (!tablesRef.current || tablesRef.current.includes(event.tableName)) {
                runQuery();
            }
        });

        return () => {
            isMountedRef.current = false;
            unsubscribe();
        };
    }, [db, runQuery]);

    return result;
}
