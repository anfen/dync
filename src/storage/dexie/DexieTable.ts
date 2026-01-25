import type { Table } from 'dexie';
import type { AddItem, StorageCollection, StorageTable, StorageWhereClause } from '../types';
import { normalizeIndexName } from './helpers';
import { DexieCollection } from './DexieCollection';
import { DexieWhereClause } from './DexieWhereClause';

export class DexieTable<T = any> implements StorageTable<T> {
    readonly name: string;
    readonly schema: unknown;
    readonly primaryKey: unknown;
    readonly raw = Object.freeze({
        add: (item: T): Promise<string> => this.table.add(item) as Promise<string>,
        put: (item: T): Promise<string> => this.table.put(item) as Promise<string>,
        update: (key: string, changes: Partial<T>) => this.table.update(key as any, changes as any),
        delete: (key: string) => this.table.delete(key as any),
        get: (key: string) => this.table.get(key as any),
        bulkAdd: (items: T[]): Promise<string[]> => this.table.bulkAdd(items, { allKeys: true }) as Promise<string[]>,
        bulkPut: (items: T[]): Promise<string[]> => this.table.bulkPut(items, { allKeys: true }) as Promise<string[]>,
        bulkUpdate: (keysAndChanges: Array<{ key: string; changes: Partial<T> }>) => this.table.bulkUpdate(keysAndChanges as any),
        bulkDelete: (keys: string[]) => this.table.bulkDelete(keys as any),
        clear: () => this.table.clear(),
    });

    private readonly table: Table<T, any, T>;

    constructor(table: Table<T, any, T>) {
        this.table = table;
        this.name = table.name;
        this.schema = table.schema;
        this.primaryKey = table.schema?.primKey;
    }

    add(item: AddItem<T>): Promise<string> {
        return this.table.add(item as T);
    }

    put(item: T): Promise<string> {
        return this.table.put(item);
    }

    update(key: string, changes: Partial<T>): Promise<number> {
        return this.table.update(key as any, changes as any);
    }

    delete(key: string): Promise<void> {
        return this.table.delete(key as any).then(() => undefined);
    }

    clear(): Promise<void> {
        return this.table.clear();
    }

    get(key: string): Promise<T | undefined> {
        return this.table.get(key as any);
    }

    toArray(): Promise<T[]> {
        return this.table.toArray();
    }

    count(): Promise<number> {
        return this.table.count();
    }

    bulkAdd(items: AddItem<T>[]): Promise<string[]> {
        return this.table.bulkAdd(items as T[], { allKeys: true }) as Promise<string[]>;
    }

    bulkPut(items: T[]): Promise<string[]> {
        return this.table.bulkPut(items, { allKeys: true }) as Promise<string[]>;
    }

    bulkGet(keys: string[]): Promise<Array<T | undefined>> {
        return this.table.bulkGet(keys as any);
    }

    bulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): Promise<number> {
        return this.table.bulkUpdate(keysAndChanges as any);
    }

    bulkDelete(keys: string[]): Promise<void> {
        return this.table.bulkDelete(keys as any);
    }

    where(index: string): StorageWhereClause<T> {
        return new DexieWhereClause(this.table.where(index));
    }

    orderBy(index: string | string[]): StorageCollection<T> {
        return new DexieCollection(this.table.orderBy(normalizeIndexName(index)));
    }

    reverse(): StorageCollection<T> {
        return new DexieCollection(this.table.reverse());
    }

    offset(offset: number): StorageCollection<T> {
        return new DexieCollection(this.table.offset(offset));
    }

    limit(count: number): StorageCollection<T> {
        return new DexieCollection(this.table.limit(count));
    }

    async each(callback: (item: T) => void | Promise<void>): Promise<void> {
        const tasks: Array<void | Promise<void>> = [];
        await this.table.each((item) => {
            tasks.push(callback(item));
        });
        await Promise.all(tasks.map((task) => (task ? Promise.resolve(task) : Promise.resolve())));
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return new DexieCollection(this.table.filter(predicate));
    }
}
