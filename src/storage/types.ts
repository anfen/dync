import type { DexieQueryContext } from './dexie/DexieQueryContext';
import type { MemoryQueryContext } from './memory/MemoryQueryContext';
import type { TableSchemaDefinition } from './sqlite/schema';
import type { StorageSchemaDefinitionOptions } from './sqlite/types';
import type { SqliteQueryContext } from './sqlite/SqliteQueryContext';

export type TransactionMode = 'r' | 'rw';

export interface StorageAdapter {
    readonly type: string;
    readonly name: string;
    open(): Promise<void>;
    close(): Promise<void>;
    delete(): Promise<void>;
    defineSchema(version: number, schema: Record<string, TableSchemaDefinition>, options?: StorageSchemaDefinitionOptions): void;
    table<T = any>(name: string): StorageTable<T>;
    transaction<T>(mode: TransactionMode, tableNames: string[], callback: (context: StorageTransactionContext) => Promise<T>): Promise<T>;
    query<R>(callback: (ctx: DexieQueryContext | SqliteQueryContext | MemoryQueryContext) => Promise<R>): Promise<R>;
}

export interface StorageTransactionContext {
    tables: Record<string, StorageTable<any>>;
}

export interface StorageCollection<T = any> {
    first(): Promise<T | undefined>;
    last(): Promise<T | undefined>;
    each(callback: (item: T, index: number) => void | Promise<void>): Promise<void>;
    eachKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void>;
    eachPrimaryKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void>;
    eachUniqueKey(callback: (key: unknown, index: number) => void | Promise<void>): Promise<void>;
    keys(): Promise<unknown[]>;
    primaryKeys(): Promise<unknown[]>;
    uniqueKeys(): Promise<unknown[]>;
    count(): Promise<number>;
    sortBy(key: string): Promise<T[]>;
    distinct(): StorageCollection<T>;
    jsFilter(predicate: (item: T) => boolean): StorageCollection<T>;
    or(index: string): StorageWhereClause<T>;
    clone(props?: Record<string, unknown>): StorageCollection<T>;
    reverse(): StorageCollection<T>;
    offset(offset: number): StorageCollection<T>;
    limit(count: number): StorageCollection<T>;
    toCollection(): StorageCollection<T>;
    delete(): Promise<number>;
    modify(changes: Partial<T> | ((item: T) => void | Promise<void>)): Promise<number>;
    toArray(): Promise<T[]>;
}

export interface StorageWhereClause<T = any> {
    equals(value: any): StorageCollection<T>;
    above(value: any): StorageCollection<T>;
    aboveOrEqual(value: any): StorageCollection<T>;
    below(value: any): StorageCollection<T>;
    belowOrEqual(value: any): StorageCollection<T>;
    between(lower: any, upper: any, includeLower?: boolean, includeUpper?: boolean): StorageCollection<T>;
    inAnyRange(ranges: Array<[any, any]>, options?: { includeLower?: boolean; includeUpper?: boolean }): StorageCollection<T>;
    startsWith(prefix: string): StorageCollection<T>;
    startsWithIgnoreCase(prefix: string): StorageCollection<T>;
    startsWithAnyOf(...prefixes: string[]): StorageCollection<T>;
    startsWithAnyOf(prefixes: string[]): StorageCollection<T>;
    startsWithAnyOfIgnoreCase(...prefixes: string[]): StorageCollection<T>;
    startsWithAnyOfIgnoreCase(prefixes: string[]): StorageCollection<T>;
    equalsIgnoreCase(value: string): StorageCollection<T>;
    anyOf(...values: any[]): StorageCollection<T>;
    anyOf(values: any[]): StorageCollection<T>;
    anyOfIgnoreCase(...values: string[]): StorageCollection<T>;
    anyOfIgnoreCase(values: string[]): StorageCollection<T>;
    noneOf(...values: any[]): StorageCollection<T>;
    noneOf(values: any[]): StorageCollection<T>;
    notEqual(value: any): StorageCollection<T>;
}

export interface StorageTable<T = any> {
    readonly name: string;
    readonly schema: unknown;
    readonly hook: unknown;
    add(item: T): Promise<unknown>;
    put(item: T): Promise<unknown>;
    update(key: unknown, changes: Partial<T>): Promise<number>;
    delete(key: unknown): Promise<void>;
    clear(): Promise<void>;
    get(key: unknown): Promise<T | undefined>;
    toArray(): Promise<T[]>;
    count(): Promise<number>;
    bulkAdd(items: T[]): Promise<unknown>;
    bulkPut(items: T[]): Promise<unknown>;
    bulkGet(keys: Array<unknown>): Promise<Array<T | undefined>>;
    bulkUpdate(keysAndChanges: Array<{ key: unknown; changes: Partial<T> }>): Promise<number>;
    bulkDelete(keys: Array<unknown>): Promise<void>;
    where(index: string | string[]): StorageWhereClause<T>;
    orderBy(index: string | string[]): StorageCollection<T>;
    reverse(): StorageCollection<T>;
    offset(offset: number): StorageCollection<T>;
    limit(count: number): StorageCollection<T>;
    mapToClass(ctor: new (...args: any[]) => any): StorageTable<T>;
    each(callback: (item: T) => void | Promise<void>): Promise<void>;
    jsFilter(predicate: (item: T) => boolean): StorageCollection<T>;
    // The "raw" property exposes the underlying storage operations without Dync sync logic.
    readonly raw: {
        add(item: T): Promise<unknown>;
        put(item: T): Promise<unknown>;
        update(key: unknown, changes: Partial<T>): Promise<number>;
        delete(key: unknown): Promise<void>;
        get(key: unknown): Promise<T | undefined>;
        bulkAdd(items: T[]): Promise<unknown>;
        bulkPut(items: T[]): Promise<unknown>;
        bulkUpdate(keysAndChanges: Array<{ key: unknown; changes: Partial<T> }>): Promise<number>;
        bulkDelete(keys: Array<unknown>): Promise<void>;
        clear(): Promise<void>;
    };
}
