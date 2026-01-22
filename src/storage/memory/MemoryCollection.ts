import type { StorageCollection, StorageWhereClause } from '../types';
import type { MemoryCollectionState, MemoryRecord } from './types';
import type { MemoryTable } from './MemoryTable';

export class MemoryCollection<T extends MemoryRecord = MemoryRecord> implements StorageCollection<T> {
    private readonly table: MemoryTable<T>;
    private readonly state: MemoryCollectionState<T>;

    constructor(table: MemoryTable<T>, state: MemoryCollectionState<T>) {
        this.table = table;
        this.state = state;
    }

    getState(): MemoryCollectionState<T> {
        return { ...this.state };
    }

    matches(record: T, key: string): boolean {
        return this.state.predicate(record, key);
    }

    clone(_props?: Record<string, unknown>): StorageCollection<T> {
        return new MemoryCollection(this.table, { ...this.state });
    }

    reverse(): StorageCollection<T> {
        return this.withState({ reverse: !this.state.reverse });
    }

    offset(offset: number): StorageCollection<T> {
        return this.withState({ offset });
    }

    limit(count: number): StorageCollection<T> {
        return this.withState({ limit: count });
    }

    toCollection(): StorageCollection<T> {
        return this.clone();
    }

    distinct(): StorageCollection<T> {
        return this.withState({ distinct: true });
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return this.withState({ predicate: this.combinePredicate(predicate, 'and') });
    }

    or(index: string): StorageWhereClause<T> {
        return this.table.createWhereClause(index, this);
    }

    async first(): Promise<T | undefined> {
        const entries = this.materializeEntries(true);
        return entries.at(0)?.[1];
    }

    async last(): Promise<T | undefined> {
        const entries = this.materializeEntries(true);
        return entries.at(-1)?.[1];
    }

    async each(callback: (item: T, index: number) => void | Promise<void>): Promise<void> {
        const entries = this.materializeEntries(true);
        for (let index = 0; index < entries.length; index += 1) {
            const [, record] = entries[index]!;
            await callback(record, index);
        }
    }

    async eachKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const keys = await this.keys();
        for (let index = 0; index < keys.length; index += 1) {
            await callback(keys[index], index);
        }
    }

    async eachPrimaryKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const keys = await this.primaryKeys();
        for (let index = 0; index < keys.length; index += 1) {
            await callback(keys[index], index);
        }
    }

    async eachUniqueKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const keys = await this.uniqueKeys();
        for (let index = 0; index < keys.length; index += 1) {
            await callback(keys[index], index);
        }
    }

    async keys(): Promise<unknown[]> {
        return this.materializeEntries(false).map(([key, record]) => this.table.resolvePublicKey(record, key));
    }

    async primaryKeys(): Promise<unknown[]> {
        return this.keys();
    }

    async uniqueKeys(): Promise<unknown[]> {
        const seen = new Set<string>();
        const keys: unknown[] = [];
        for (const [key, record] of this.materializeEntries(false)) {
            const publicKey = this.table.resolvePublicKey(record, key);
            const signature = JSON.stringify(publicKey);
            if (!seen.has(signature)) {
                seen.add(signature);
                keys.push(publicKey);
            }
        }
        return keys;
    }

    async count(): Promise<number> {
        return this.materializeEntries(false).length;
    }

    async sortBy(key: string): Promise<T[]> {
        const entries = this.materializeEntries(true);
        entries.sort((a, b) => this.table.compareValues((a[1] as any)[key], (b[1] as any)[key]));
        return entries.map(([, record]) => record);
    }

    async delete(): Promise<number> {
        const entries = this.materializeEntries(false);
        for (const [key] of entries) {
            this.table.deleteByKey(key);
        }
        return entries.length;
    }

    async modify(changes: Partial<T> | ((item: T) => void | Promise<void>)): Promise<number> {
        const entries = this.materializeEntries(false);
        let modified = 0;
        for (const [key] of entries) {
            const current = this.table.getMutableRecord(key);
            if (!current) {
                continue;
            }
            if (typeof changes === 'function') {
                const clone = this.table.cloneRecord(current);
                await changes(clone);
                (clone as MemoryRecord)._localId = current._localId ?? key;
                this.table.setMutableRecord(key, clone);
            } else {
                const updated = { ...current, ...changes, _localId: current._localId ?? key } as T;
                this.table.setMutableRecord(key, updated);
            }
            modified += 1;
        }
        return modified;
    }

    async toArray(): Promise<T[]> {
        return this.materializeEntries(true).map(([, record]) => record);
    }

    private withState(overrides: Partial<MemoryCollectionState<T>>): MemoryCollection<T> {
        return new MemoryCollection(this.table, {
            ...this.state,
            ...overrides,
            predicate: overrides.predicate ?? this.state.predicate,
        });
    }

    private combinePredicate(predicate: (record: T) => boolean, mode: 'and' | 'or'): (record: T, key: string) => boolean {
        if (mode === 'and') {
            return (record: T, key: string) => this.state.predicate(record, key) && predicate(record);
        }
        return (record: T, key: string) => this.state.predicate(record, key) || predicate(record);
    }

    private materializeEntries(clone: boolean): Array<[string, T]> {
        let entries = this.table.entries().filter(([key, record]) => this.state.predicate(record, key));

        if (this.state.orderBy) {
            const { index, direction } = this.state.orderBy;
            entries = [...entries].sort((a, b) => this.table.compareEntries(a[1], b[1], index));
            if (direction === 'desc') {
                entries.reverse();
            }
        }

        if (this.state.reverse) {
            entries = [...entries].reverse();
        }

        if (this.state.distinct) {
            const seen = new Set<string>();
            entries = entries.filter(([, record]) => {
                const signature = JSON.stringify(record);
                if (seen.has(signature)) {
                    return false;
                }
                seen.add(signature);
                return true;
            });
        }

        if (this.state.offset > 0) {
            entries = entries.slice(this.state.offset);
        }

        if (typeof this.state.limit === 'number') {
            entries = entries.slice(0, this.state.limit);
        }

        if (clone) {
            return entries.map(([key, record]) => [key, this.table.cloneRecord(record)] as [string, T]);
        }

        return entries;
    }
}
