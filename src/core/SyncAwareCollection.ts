import type { StorageCollection, StorageTable, StorageWhereClause } from '../storage/types';
import { SyncAwareWhereClause } from './SyncAwareWhereClause';

/**
 * Wraps a StorageCollection so that modify() and delete() create pending sync
 * changes by delegating to the already-wrapped table.bulkUpdate / bulkDelete.
 * All read and chaining operations delegate transparently to the inner collection.
 */
export class SyncAwareCollection<T> implements StorageCollection<T> {
    constructor(
        private readonly inner: StorageCollection<T>,
        private readonly tableRef: StorageTable<any>,
    ) {}

    private wrap(col: StorageCollection<T>): SyncAwareCollection<T> {
        return new SyncAwareCollection(col, this.tableRef);
    }

    // ---- read-only / pass-through ----
    first() {
        return this.inner.first();
    }
    last() {
        return this.inner.last();
    }
    each(cb: (item: T, idx: number) => void | Promise<void>) {
        return this.inner.each(cb);
    }
    eachKey(cb: (key: unknown, idx: number) => void | Promise<void>) {
        return this.inner.eachKey(cb);
    }
    eachPrimaryKey(cb: (key: unknown, idx: number) => void | Promise<void>) {
        return this.inner.eachPrimaryKey(cb);
    }
    eachUniqueKey(cb: (key: unknown, idx: number) => void | Promise<void>) {
        return this.inner.eachUniqueKey(cb);
    }
    keys() {
        return this.inner.keys();
    }
    primaryKeys() {
        return this.inner.primaryKeys();
    }
    uniqueKeys() {
        return this.inner.uniqueKeys();
    }
    count() {
        return this.inner.count();
    }
    sortBy(key: string) {
        return this.inner.sortBy(key);
    }
    toArray() {
        return this.inner.toArray();
    }

    // ---- chaining — preserve sync-awareness ----
    distinct() {
        return this.wrap(this.inner.distinct());
    }
    clone(props?: Record<string, unknown>) {
        return this.wrap(this.inner.clone(props));
    }
    reverse() {
        return this.wrap(this.inner.reverse());
    }
    offset(n: number) {
        return this.wrap(this.inner.offset(n));
    }
    limit(n: number) {
        return this.wrap(this.inner.limit(n));
    }
    toCollection() {
        return this.wrap(this.inner.toCollection());
    }
    jsFilter(predicate: (item: T) => boolean) {
        return this.wrap(this.inner.jsFilter(predicate));
    }
    or(index: string): StorageWhereClause<T> {
        return new SyncAwareWhereClause(this.inner.or(index), this.tableRef);
    }

    // ---- sync-aware mutations ----

    async delete(): Promise<number> {
        const records = await this.inner.toArray();
        if (records.length === 0) return 0;
        const keys = records.map((r: any) => r._localId as string);
        await this.tableRef.bulkDelete(keys);
        return records.length;
    }

    async modify(changes: Partial<T> | ((item: T) => void | Promise<void>)): Promise<number> {
        const records = await this.inner.toArray();
        if (records.length === 0) return 0;

        if (typeof changes === 'function') {
            const keysAndChanges: Array<{ key: string; changes: Partial<T> }> = [];
            for (const record of records) {
                const draft = { ...record } as T;
                await (changes as (item: T) => void | Promise<void>)(draft);
                // Compute shallow delta
                const delta: Partial<T> = {};
                const allKeys = new Set([...Object.keys(record as object), ...Object.keys(draft as object)]) as Set<keyof T>;
                for (const key of allKeys) {
                    if ((draft as any)[key] !== (record as any)[key]) {
                        (delta as any)[key] = (draft as any)[key];
                    }
                }
                if (Object.keys(delta).length > 0) {
                    keysAndChanges.push({ key: (record as any)._localId, changes: delta });
                }
            }
            if (keysAndChanges.length > 0) {
                await this.tableRef.bulkUpdate(keysAndChanges as any);
            }
        } else {
            const keysAndChanges = records.map((r: any) => ({ key: r._localId as string, changes }));
            await this.tableRef.bulkUpdate(keysAndChanges as any);
        }

        return records.length;
    }
}
