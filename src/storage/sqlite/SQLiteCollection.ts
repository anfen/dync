import type { StorageCollection, StorageWhereClause } from '../types';
import { LOCAL_PK } from '../../types';
import type { SQLiteCollectionState, SQLiteCondition, TableEntry } from './types';
import { createDefaultState, cloneValue, buildWhereClause } from './helpers';
import { SQLiteTable } from './SQLiteTable';

export class SQLiteCollection<T = any> implements StorageCollection<T> {
    private readonly table: SQLiteTable<T>;
    private readonly state: SQLiteCollectionState<T>;

    constructor(table: SQLiteTable<T>, state?: Partial<SQLiteCollectionState<T>>) {
        this.table = table;
        const base = createDefaultState<T>();
        this.state = {
            ...base,
            ...state,
            sqlConditions: state?.sqlConditions ?? base.sqlConditions,
            jsPredicate: state?.jsPredicate,
        };
    }

    getState(): SQLiteCollectionState<T> {
        return { ...this.state, sqlConditions: [...this.state.sqlConditions] };
    }

    // Add a SQL-expressible condition to this collection
    addSqlCondition(condition: SQLiteCondition): SQLiteCollection<T> {
        return new SQLiteCollection(this.table, {
            ...this.state,
            sqlConditions: [...this.state.sqlConditions, condition],
        });
    }

    private replicate(overrides?: Partial<SQLiteCollectionState<T>>): SQLiteCollection<T> {
        return new SQLiteCollection(this.table, {
            ...this.state,
            ...overrides,
            sqlConditions: overrides?.sqlConditions ?? this.state.sqlConditions,
            jsPredicate: overrides?.jsPredicate !== undefined ? overrides.jsPredicate : this.state.jsPredicate,
        });
    }

    private withJsPredicate(predicate: (record: T, key: string, index: number) => boolean): SQLiteCollection<T> {
        const existingPredicate = this.state.jsPredicate;
        const combined = existingPredicate
            ? (record: T, key: string, index: number) => existingPredicate(record, key, index) && predicate(record, key, index)
            : predicate;
        return new SQLiteCollection(this.table, {
            ...this.state,
            jsPredicate: combined,
        });
    }

    private hasJsPredicate(): boolean {
        return this.state.jsPredicate !== undefined;
    }

    private resolveOrdering(): { index: string | string[]; direction: 'asc' | 'desc' } {
        const base = this.state.orderBy ?? { index: LOCAL_PK, direction: 'asc' as const };
        const direction = this.state.reverse ? (base.direction === 'asc' ? 'desc' : 'asc') : base.direction;
        return { index: base.index, direction };
    }

    /**
     * Execute a native SQL query with all SQL conditions.
     * If there's a JS predicate, we fetch rows without LIMIT/OFFSET in SQL
     * and apply them after JS filtering.
     */
    private async executeQuery(
        options: {
            clone?: boolean;
            limitOverride?: number;
            orderByOverride?: { index: string | string[]; direction: 'asc' | 'desc' };
        } = {},
    ): Promise<TableEntry<T>[]> {
        const { whereClause, parameters } = buildWhereClause(this.state.sqlConditions);
        const ordering = options.orderByOverride ?? this.resolveOrdering();
        const cloneValues = options.clone !== false;
        const hasJsFilter = this.hasJsPredicate();
        const distinct = this.state.distinct;

        // If we have a JS predicate, we can't apply LIMIT/OFFSET in SQL
        // because we don't know which rows will pass the JS filter
        const sqlLimit = hasJsFilter ? undefined : (options.limitOverride ?? this.state.limit);
        const sqlOffset = hasJsFilter ? undefined : this.state.offset;

        const rows = await this.table.queryWithConditions({
            whereClause,
            parameters,
            orderBy: ordering,
            limit: sqlLimit,
            offset: sqlOffset,
            distinct,
        });

        let results: TableEntry<T>[] = rows.map((row) => ({
            key: String((row as any)[LOCAL_PK]),
            value: row,
        }));

        // Apply JS predicate if present
        if (hasJsFilter) {
            const predicate = this.state.jsPredicate!;
            results = results.filter((entry, index) => predicate(entry.value, entry.key, index));

            // Apply offset/limit in JS since we couldn't apply them in SQL
            const offset = Math.max(0, this.state.offset ?? 0);
            const limit = options.limitOverride ?? this.state.limit;
            if (offset > 0 || limit !== undefined) {
                const end = limit !== undefined ? offset + limit : undefined;
                results = results.slice(offset, end);
            }
        }

        // Clone values if needed
        if (cloneValues) {
            results = results.map((entry) => ({
                key: entry.key,
                value: this.table.cloneRecord(entry.value),
            }));
        }

        return results;
    }

    async first(): Promise<T | undefined> {
        const entries = await this.executeQuery({ limitOverride: 1 });
        return entries[0]?.value;
    }

    async last(): Promise<T | undefined> {
        return this.replicate({ reverse: !this.state.reverse }).first();
    }

    async each(callback: (item: T, index: number) => void | Promise<void>): Promise<void> {
        const entries = await this.executeQuery();
        for (const [index, entry] of entries.entries()) {
            await callback(entry.value, index);
        }
    }

    async eachKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const entries = await this.executeQuery({ clone: false });
        for (const [index, entry] of entries.entries()) {
            await callback(entry.key, index);
        }
    }

    async eachPrimaryKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        return this.eachKey(callback);
    }

    async eachUniqueKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const keys = await this.uniqueKeys();
        for (let index = 0; index < keys.length; index += 1) {
            await callback(keys[index], index);
        }
    }

    async keys(): Promise<unknown[]> {
        // Optimization: use native SQL when no JS filtering needed
        if (!this.hasJsPredicate()) {
            const { whereClause, parameters } = buildWhereClause(this.state.sqlConditions);
            const ordering = this.resolveOrdering();
            return this.table.queryKeysWithConditions({
                whereClause,
                parameters,
                orderBy: ordering,
                limit: this.state.limit,
                offset: this.state.offset,
                distinct: this.state.distinct,
            });
        }
        // Fallback for JS filtering
        const entries = await this.executeQuery({ clone: false });
        return entries.map((entry) => entry.key);
    }

    async primaryKeys(): Promise<unknown[]> {
        return this.keys();
    }

    async uniqueKeys(): Promise<unknown[]> {
        // Optimization: use native SQL DISTINCT when no JS filtering needed
        if (!this.hasJsPredicate()) {
            const { whereClause, parameters } = buildWhereClause(this.state.sqlConditions);
            const ordering = this.resolveOrdering();
            return this.table.queryKeysWithConditions({
                whereClause,
                parameters,
                orderBy: ordering,
                limit: this.state.limit,
                offset: this.state.offset,
                distinct: true,
            });
        }
        // Fallback for JS filtering
        const keys = await this.keys();
        return [...new Set(keys)];
    }

    async count(): Promise<number> {
        // Optimization: use SQL COUNT when no JS filtering needed
        if (!this.hasJsPredicate()) {
            return this.table.countWithConditions({
                whereClause: buildWhereClause(this.state.sqlConditions).whereClause,
                parameters: buildWhereClause(this.state.sqlConditions).parameters,
                distinct: this.state.distinct,
            });
        }
        // Fallback for JS filtering
        const entries = await this.executeQuery({ clone: false });
        return entries.length;
    }

    async sortBy(key: string): Promise<T[]> {
        const entries = await this.executeQuery({
            orderByOverride: { index: key, direction: 'asc' },
        });
        return entries.map((entry) => entry.value);
    }

    distinct(): StorageCollection<T> {
        return this.replicate({ distinct: true });
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return this.withJsPredicate((record: T) => predicate(cloneValue(record)));
    }

    or(index: string): StorageWhereClause<T> {
        return this.table.createWhereClause(index, this);
    }

    clone(_props?: Record<string, unknown>): StorageCollection<T> {
        return this.replicate();
    }

    reverse(): StorageCollection<T> {
        return this.replicate({ reverse: !this.state.reverse });
    }

    offset(offset: number): StorageCollection<T> {
        return this.replicate({ offset });
    }

    limit(count: number): StorageCollection<T> {
        return this.replicate({ limit: count });
    }

    toCollection(): StorageCollection<T> {
        return this.replicate();
    }

    async delete(): Promise<number> {
        // Optimization: use native SQL DELETE when no JS filtering needed
        if (!this.hasJsPredicate()) {
            const { whereClause, parameters } = buildWhereClause(this.state.sqlConditions);
            return this.table.deleteWithConditions({ whereClause, parameters });
        }
        // Fallback for JS filtering - must iterate and delete one by one
        const entries = await this.executeQuery({ clone: false });
        for (const entry of entries) {
            await this.table.deleteByPrimaryKey(entry.key);
        }
        return entries.length;
    }

    async modify(changes: Partial<T> | ((item: T) => void | Promise<void>)): Promise<number> {
        // Optimization: use native SQL UPDATE when changes is an object and no JS filtering
        if (typeof changes !== 'function' && !this.hasJsPredicate()) {
            const { whereClause, parameters } = buildWhereClause(this.state.sqlConditions);
            return this.table.updateWithConditions({ whereClause, parameters, changes });
        }
        // Fallback for function-based changes or JS filtering
        const entries = await this.executeQuery();
        for (const entry of entries) {
            const draft = cloneValue(entry.value);
            if (typeof changes === 'function') {
                await changes(draft);
            } else {
                Object.assign(draft as object, changes);
            }
            await this.table.replaceRecord(draft);
        }
        return entries.length;
    }

    async toArray(): Promise<T[]> {
        const entries = await this.executeQuery();
        return entries.map((entry) => entry.value);
    }
}
