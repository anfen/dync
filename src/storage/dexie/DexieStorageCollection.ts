import type { Collection as DexieCollection } from 'dexie';
import type { StorageCollection, StorageWhereClause } from '../types';
import { normalizeIndexName } from './helpers';
import { DexieStorageWhereClause } from './DexieStorageWhereClause';

export class DexieStorageCollection<T = any> implements StorageCollection<T> {
    private readonly collection: DexieCollection<T, any, T>;

    constructor(collection: DexieCollection<T, any, T>) {
        this.collection = collection;
    }

    first(): Promise<T | undefined> {
        return this.collection.first();
    }

    async last(): Promise<T | undefined> {
        return this.collection.last();
    }

    async each(callback: (item: T, index: number) => void | Promise<void>): Promise<void> {
        const tasks: Array<void | Promise<void>> = [];
        let index = 0;
        await this.collection.each((item) => {
            tasks.push(callback(item, index));
            index += 1;
        });
        await Promise.all(tasks.map((task) => (task ? Promise.resolve(task) : Promise.resolve())));
    }

    async eachKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const tasks: Array<void | Promise<void>> = [];
        let index = 0;
        await this.collection.eachKey((key) => {
            tasks.push(callback(key, index));
            index += 1;
        });
        await Promise.all(tasks.map((task) => (task ? Promise.resolve(task) : Promise.resolve())));
    }

    async eachPrimaryKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const tasks: Array<void | Promise<void>> = [];
        let index = 0;
        await this.collection.eachPrimaryKey((key) => {
            tasks.push(callback(key, index));
            index += 1;
        });
        await Promise.all(tasks.map((task) => (task ? Promise.resolve(task) : Promise.resolve())));
    }

    async eachUniqueKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void> {
        const tasks: Array<void | Promise<void>> = [];
        let index = 0;
        await this.collection.eachUniqueKey((key) => {
            tasks.push(callback(key, index));
            index += 1;
        });
        await Promise.all(tasks.map((task) => (task ? Promise.resolve(task) : Promise.resolve())));
    }

    keys(): Promise<unknown[]> {
        return this.collection.keys();
    }

    primaryKeys(): Promise<unknown[]> {
        return this.collection.primaryKeys();
    }

    uniqueKeys(): Promise<unknown[]> {
        return this.collection.uniqueKeys();
    }

    count(): Promise<number> {
        return this.collection.count();
    }

    sortBy(key: string): Promise<T[]> {
        return this.collection.sortBy(key);
    }

    distinct(): StorageCollection<T> {
        return new DexieStorageCollection(this.collection.distinct());
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return new DexieStorageCollection(this.collection.filter(predicate));
    }

    or(index: string): StorageWhereClause<T> {
        return new DexieStorageWhereClause(this.collection.or(normalizeIndexName(index)));
    }

    clone(props?: Record<string, unknown>): StorageCollection<T> {
        return new DexieStorageCollection(this.collection.clone(props));
    }

    reverse(): StorageCollection<T> {
        return new DexieStorageCollection(this.collection.reverse());
    }

    offset(offset: number): StorageCollection<T> {
        return new DexieStorageCollection(this.collection.offset(offset));
    }

    limit(count: number): StorageCollection<T> {
        return new DexieStorageCollection(this.collection.limit(count));
    }

    toCollection(): StorageCollection<T> {
        return this.clone();
    }

    delete(): Promise<number> {
        return this.collection.delete();
    }

    modify(changes: Partial<T> | ((item: T) => void | Promise<void>)): Promise<number> {
        return this.collection.modify(changes as any);
    }

    toArray(): Promise<T[]> {
        return this.collection.toArray();
    }
}
