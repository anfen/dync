import type { AddItem, StorageCollection, StorageTable, StorageWhereClause } from '../types';
import { LOCAL_PK } from '../../types';
import { createLocalId } from '../../helpers';
import type { MemoryCollectionState, MemoryRecord } from './types';
import { createDefaultState } from './types';
import { MemoryCollection } from './MemoryCollection';
import { MemoryWhereClause } from './MemoryWhereClause';

export class MemoryTable<T extends MemoryRecord = MemoryRecord> implements StorageTable<T> {
    readonly name: string;
    readonly schema: unknown = undefined;
    readonly primaryKey: unknown = LOCAL_PK;
    readonly raw: {
        add: (item: T) => Promise<string>;
        put: (item: T) => Promise<string>;
        update: (key: string, changes: Partial<T>) => Promise<number>;
        delete: (key: string) => Promise<void>;
        get: (key: string) => Promise<T | undefined>;
        bulkAdd: (items: T[]) => Promise<string[]>;
        bulkPut: (items: T[]) => Promise<string[]>;
        bulkUpdate: (keysAndChanges: Array<{ key: string; changes: Partial<T> }>) => Promise<number>;
        bulkDelete: (keys: string[]) => Promise<void>;
        clear: () => Promise<void>;
    };
    private readonly records = new Map<string, T>();

    constructor(name: string) {
        this.name = name;
        this.raw = {
            add: async (item: T) => this.baseAdd(item),
            put: async (item: T) => this.basePut(item),
            update: async (key: string, changes: Partial<T>) => this.baseUpdate(key, changes),
            delete: async (key: string) => {
                this.baseDelete(key);
            },
            get: async (key: string) => this.baseGet(key),
            bulkAdd: async (items: T[]) => this.baseBulkAdd(items),
            bulkPut: async (items: T[]) => this.baseBulkPut(items),
            bulkUpdate: async (keysAndChanges: Array<{ key: string; changes: Partial<T> }>) => this.baseBulkUpdate(keysAndChanges),
            bulkDelete: async (keys: string[]) => this.baseBulkDelete(keys),
            clear: async () => this.baseClear(),
        };
    }

    async add(item: AddItem<T>): Promise<string> {
        return this.baseAdd(item as T);
    }

    async put(item: T): Promise<string> {
        return this.basePut(item);
    }

    async update(key: string, changes: Partial<T>): Promise<number> {
        return this.baseUpdate(key, changes);
    }

    async delete(key: string): Promise<void> {
        this.baseDelete(key);
    }

    async clear(): Promise<void> {
        this.baseClear();
    }

    private baseClear(): void {
        this.records.clear();
    }

    async get(key: string): Promise<T | undefined> {
        const stored = this.baseGet(key);
        return stored ? this.cloneRecord(stored) : undefined;
    }

    async toArray(): Promise<T[]> {
        return this.entries().map(([, record]) => this.cloneRecord(record));
    }

    async count(): Promise<number> {
        return this.records.size;
    }

    async bulkAdd(items: AddItem<T>[]): Promise<string[]> {
        return this.baseBulkAdd(items as T[]);
    }

    private baseBulkAdd(items: T[]): string[] {
        const keys: string[] = [];
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            keys.push(this.baseAdd(item));
        }
        return keys;
    }

    async bulkPut(items: T[]): Promise<string[]> {
        return this.baseBulkPut(items);
    }

    private baseBulkPut(items: T[]): string[] {
        const keys: string[] = [];
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            keys.push(this.basePut(item));
        }
        return keys;
    }

    async bulkGet(keys: string[]): Promise<Array<T | undefined>> {
        return Promise.all(keys.map((key) => this.get(key)));
    }

    async bulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): Promise<number> {
        return this.baseBulkUpdate(keysAndChanges);
    }

    private baseBulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): number {
        let updatedCount = 0;
        for (const { key, changes } of keysAndChanges) {
            const result = this.baseUpdate(key, changes);
            updatedCount += result;
        }
        return updatedCount;
    }

    async bulkDelete(keys: string[]): Promise<void> {
        this.baseBulkDelete(keys);
    }

    private baseBulkDelete(keys: string[]): void {
        for (const key of keys) {
            this.baseDelete(key);
        }
    }

    where(index: string): StorageWhereClause<T> {
        return this.createWhereClause(index);
    }

    orderBy(index: string | string[]): StorageCollection<T> {
        return this.createCollection({
            orderBy: { index, direction: 'asc' },
        });
    }

    reverse(): StorageCollection<T> {
        return this.createCollection({ reverse: true });
    }

    offset(offset: number): StorageCollection<T> {
        return this.createCollection({ offset });
    }

    limit(count: number): StorageCollection<T> {
        return this.createCollection({ limit: count });
    }

    async each(callback: (item: T) => void | Promise<void>): Promise<void> {
        for (const [, record] of this.entries()) {
            await callback(this.cloneRecord(record));
        }
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return this.createCollection({ predicate: (record) => predicate(record) });
    }

    private createCollection(stateOverrides?: Partial<MemoryCollectionState<T>>): MemoryCollection<T> {
        const baseState = createDefaultState<T>();
        const state: MemoryCollectionState<T> = {
            ...baseState,
            ...stateOverrides,
            predicate: stateOverrides?.predicate ?? baseState.predicate,
        };
        return new MemoryCollection(this, state);
    }

    createCollectionFromPredicate(predicate: (record: T, key: string) => boolean, template?: MemoryCollection<T>): MemoryCollection<T> {
        const baseState = template ? template.getState() : createDefaultState<T>();
        return new MemoryCollection(this, {
            ...baseState,
            predicate,
        });
    }

    createWhereClause(column: string, baseCollection?: MemoryCollection<T>): MemoryWhereClause<T> {
        return new MemoryWhereClause(this, column, baseCollection);
    }

    entries(): Array<[string, T]> {
        return Array.from(this.records.entries());
    }

    cloneRecord(record: T): T {
        return { ...(record as object) } as T;
    }

    deleteByKey(key: string): void {
        this.records.delete(key);
    }

    getMutableRecord(key: string): T | undefined {
        return this.records.get(key);
    }

    setMutableRecord(key: string, record: T): void {
        this.records.set(key, { ...record, _localId: record._localId ?? key } as T);
    }

    resolvePublicKey(record: T, key: string): unknown {
        if (record._localId !== undefined) {
            return record._localId;
        }
        if (record.id !== undefined) {
            return record.id;
        }
        return key;
    }

    getIndexValue(record: T, index: string | string[]): unknown {
        if (Array.isArray(index)) {
            return index.map((key) => (record as any)[key]);
        }
        return (record as any)[index];
    }

    compareEntries(left: T, right: T, index: string | string[]): number {
        if (Array.isArray(index)) {
            for (const key of index) {
                const diff = this.compareValues((left as any)[key], (right as any)[key]);
                if (diff !== 0) {
                    return diff;
                }
            }
            return 0;
        }
        return this.compareValues((left as any)[index], (right as any)[index]);
    }

    compareValues(left: unknown, right: unknown): number {
        const normalizedLeft = this.normalizeComparableValue(left) as any;
        const normalizedRight = this.normalizeComparableValue(right) as any;
        if (normalizedLeft < normalizedRight) {
            return -1;
        }
        if (normalizedLeft > normalizedRight) {
            return 1;
        }
        return 0;
    }

    private normalizeComparableValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map((entry) => this.normalizeComparableValue(entry));
        }
        if (value instanceof Date) {
            return value.valueOf();
        }
        return value ?? null;
    }

    private baseAdd(item: T): string {
        const primaryKey = this.createPrimaryKey(item);
        const stored = { ...item, _localId: primaryKey } as T;
        this.records.set(primaryKey, stored);
        return primaryKey;
    }

    private basePut(item: T): string {
        const primaryKey = this.createPrimaryKey(item);
        const stored = { ...item, _localId: primaryKey } as T;
        this.records.set(primaryKey, stored);
        return primaryKey;
    }

    private baseUpdate(key: string, changes: Partial<T>): number {
        const primaryKey = this.resolveKey(key);
        if (!primaryKey) {
            return 0;
        }
        const existing = this.records.get(primaryKey);
        if (!existing) {
            return 0;
        }
        const updated = { ...existing, ...changes, _localId: existing._localId ?? primaryKey } as T;
        this.records.set(primaryKey, updated);
        return 1;
    }

    private baseDelete(key: string): void {
        const primaryKey = this.resolveKey(key);
        if (primaryKey) {
            this.records.delete(primaryKey);
        }
    }

    private baseGet(key: string): T | undefined {
        const primaryKey = this.resolveKey(key);
        if (!primaryKey) {
            return undefined;
        }
        return this.records.get(primaryKey);
    }

    private createPrimaryKey(item: T): string {
        if (item._localId && typeof item._localId === 'string') {
            return item._localId;
        }
        if (item.id !== undefined && (typeof item.id === 'string' || typeof item.id === 'number' || typeof item.id === 'bigint')) {
            return String(item.id);
        }
        return createLocalId();
    }

    private resolveKey(key: unknown): string | undefined {
        if (typeof key === 'string') {
            return key;
        }
        if (typeof key === 'number' || typeof key === 'bigint') {
            return String(key);
        }
        if (key && typeof key === 'object' && 'id' in (key as Record<string, unknown>)) {
            const lookup = (key as Record<string, unknown>).id;
            for (const [storedKey, record] of this.records.entries()) {
                if (record.id === lookup) {
                    return storedKey;
                }
            }
        }
        return undefined;
    }
}
