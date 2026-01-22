import type { Table as DexieTable } from 'dexie';
import type { StorageCollection, StorageTable, StorageWhereClause } from '../types';
import { normalizeIndexName } from './helpers';
import { DexieStorageCollection } from './DexieStorageCollection';
import { DexieStorageWhereClause } from './DexieStorageWhereClause';

export class DexieStorageTable<T = any> implements StorageTable<T> {
    readonly name: string;
    readonly schema: unknown;
    readonly primaryKey: unknown;
    readonly hook: unknown;
    readonly raw = Object.freeze({
        add: (item: T) => this.table.add(item),
        put: (item: T) => this.table.put(item),
        update: (key: unknown, changes: Partial<T>) => this.table.update(key as any, changes as any),
        delete: (key: unknown) => this.table.delete(key as any),
        get: (key: unknown) => this.table.get(key as any),
        bulkAdd: (items: T[]) => this.table.bulkAdd(items),
        bulkPut: (items: T[]) => this.table.bulkPut(items),
        bulkUpdate: (keysAndChanges: Array<{ key: unknown; changes: Partial<T> }>) => this.table.bulkUpdate(keysAndChanges as any),
        bulkDelete: (keys: Array<unknown>) => this.table.bulkDelete(keys as any),
        clear: () => this.table.clear(),
    });

    private readonly table: DexieTable<T, any, T>;

    constructor(table: DexieTable<T, any, T>) {
        this.table = table;
        this.name = table.name;
        this.schema = table.schema;
        this.primaryKey = table.schema?.primKey;
        this.hook = table.hook;
    }

    add(item: T): Promise<unknown> {
        return this.table.add(item);
    }

    put(item: T): Promise<unknown> {
        return this.table.put(item);
    }

    update(key: unknown, changes: Partial<T>): Promise<number> {
        return this.table.update(key as any, changes as any);
    }

    delete(key: unknown): Promise<void> {
        return this.table.delete(key as any).then(() => undefined);
    }

    clear(): Promise<void> {
        return this.table.clear();
    }

    get(key: unknown): Promise<T | undefined> {
        return this.table.get(key as any);
    }

    toArray(): Promise<T[]> {
        return this.table.toArray();
    }

    count(): Promise<number> {
        return this.table.count();
    }

    bulkAdd(items: T[]): Promise<unknown> {
        return this.table.bulkAdd(items);
    }

    bulkPut(items: T[]): Promise<unknown> {
        return this.table.bulkPut(items);
    }

    bulkGet(keys: Array<unknown>): Promise<Array<T | undefined>> {
        return this.table.bulkGet(keys as any);
    }

    bulkUpdate(keysAndChanges: Array<{ key: unknown; changes: Partial<T> }>): Promise<number> {
        return this.table.bulkUpdate(keysAndChanges as any);
    }

    bulkDelete(keys: Array<unknown>): Promise<void> {
        return this.table.bulkDelete(keys as any);
    }

    where(index: string | string[]): StorageWhereClause<T> {
        return new DexieStorageWhereClause(this.table.where(normalizeIndexName(index)));
    }

    orderBy(index: string | string[]): StorageCollection<T> {
        return new DexieStorageCollection(this.table.orderBy(normalizeIndexName(index)));
    }

    reverse(): StorageCollection<T> {
        return new DexieStorageCollection(this.table.reverse());
    }

    offset(offset: number): StorageCollection<T> {
        return new DexieStorageCollection(this.table.offset(offset));
    }

    limit(count: number): StorageCollection<T> {
        return new DexieStorageCollection(this.table.limit(count));
    }

    mapToClass(ctor: new (...args: any[]) => any): StorageTable<T> {
        this.table.mapToClass(ctor as any);
        return this;
    }

    async each(callback: (item: T) => void | Promise<void>): Promise<void> {
        const tasks: Array<void | Promise<void>> = [];
        await this.table.each((item) => {
            tasks.push(callback(item));
        });
        await Promise.all(tasks.map((task) => (task ? Promise.resolve(task) : Promise.resolve())));
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return new DexieStorageCollection(this.table.filter(predicate));
    }
}
