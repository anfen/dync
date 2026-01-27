import type { DexieQueryContext } from './dexie/DexieQueryContext';
import type { MemoryQueryContext } from './memory/MemoryQueryContext';
import type { TableSchemaDefinition } from './sqlite/schema';
import type { StorageSchemaDefinitionOptions } from './sqlite/types';
import type { SQLiteQueryContext } from './sqlite/SQLiteQueryContext';

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
    query<R>(callback: (ctx: DexieQueryContext | SQLiteQueryContext | MemoryQueryContext) => Promise<R>): Promise<R>;
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

// Item type for add operations - _localId is optional since Dync auto-generates it
export type AddItem<T> = Omit<T, '_localId'> & { _localId?: string };

export interface StorageTable<T = any> {
    readonly name: string;
    readonly schema: unknown;
    add(item: AddItem<T>): Promise<string>;
    put(item: T): Promise<string>;
    update(key: string, changes: Partial<T>): Promise<number>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    get(key: string): Promise<T | undefined>;
    toArray(): Promise<T[]>;
    count(): Promise<number>;
    bulkAdd(items: AddItem<T>[]): Promise<string[]>;
    bulkPut(items: T[]): Promise<string[]>;
    bulkGet(keys: string[]): Promise<Array<T | undefined>>;
    bulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): Promise<number>;
    bulkDelete(keys: string[]): Promise<void>;
    where(index: string): StorageWhereClause<T>;
    orderBy(index: string | string[]): StorageCollection<T>;
    reverse(): StorageCollection<T>;
    offset(offset: number): StorageCollection<T>;
    limit(count: number): StorageCollection<T>;
    each(callback: (item: T) => void | Promise<void>): Promise<void>;
    jsFilter(predicate: (item: T) => boolean): StorageCollection<T>;
    // The "raw" property exposes the underlying storage operations without Dync sync logic.
    readonly raw: {
        add(item: T): Promise<string>;
        put(item: T): Promise<string>;
        update(key: string, changes: Partial<T>): Promise<number>;
        delete(key: string): Promise<void>;
        get(key: string): Promise<T | undefined>;
        bulkAdd(items: T[]): Promise<string[]>;
        bulkPut(items: T[]): Promise<string[]>;
        bulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): Promise<number>;
        bulkDelete(keys: string[]): Promise<void>;
        clear(): Promise<void>;
    };
}
