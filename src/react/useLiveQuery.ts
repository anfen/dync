import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutationEvent } from '../types';
import type { DyncLike } from './types';

/**
 * React hook that observes database queries and automatically re-runs them when data changes.
 *
 * @param db - The Dync database instance
 * @param querier - Function that returns query result (can be async)
 * @param deps - Optional React dependency list for re-running the query
 * @param tables - Optional array of table names to watch for mutations (defaults to all tables)
 * @returns The query result, or undefined if not yet available
 *
 * @example
 * ```tsx
 * import { db } from './store';
 * import { useLiveQuery } from '@anfenn/dync/react';
 *
 * function TodoList() {
 *   const todos = useLiveQuery(db, () => db.todos.toArray());
 *   return <ul>{todos?.map(t => <li key={t._localId}>{t.title}</li>)}</ul>;
 * }
 *
 * // With dependencies
 * function FilteredTodos({ filter }: { filter: string }) {
 *   const todos = useLiveQuery(
 *     db,
 *     () => db.todos.where('status').equals(filter).toArray(),
 *     [filter]
 *   );
 *   return <ul>{todos?.map(t => <li key={t._localId}>{t.title}</li>)}</ul>;
 * }
 *
 * // Watch specific tables only
 * function TodoCount() {
 *   const count = useLiveQuery(
 *     db,
 *     () => db.todos.count(),
 *     [],
 *     ['todos']
 *   );
 *   return <span>{count ?? 0} todos</span>;
 * }
 * ```
 */
export function useLiveQuery<T>(db: DyncLike, querier: () => Promise<T> | T, deps: React.DependencyList = [], tables?: string[]): T | undefined {
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
            const queryResult = await querierRef.current();
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
    }, []);

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
