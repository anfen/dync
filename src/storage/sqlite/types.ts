import type { SQLiteColumnDefinition, SQLiteTableDefinition } from './schema';

export interface SQLiteAdapterOptions {
    debug?: boolean;
}

export interface SQLiteColumnSchema extends SQLiteColumnDefinition {
    name: string;
}

export interface SQLiteNormalizedTableDefinition extends SQLiteTableDefinition {
    name: string;
    columns: Record<string, SQLiteColumnSchema>;
    source: 'dexie' | 'structured';
}

export interface SQLiteTableSchemaMetadata {
    name: string;
    definition: SQLiteNormalizedTableDefinition;
}

export type SQLiteComparisonOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

export interface SQLiteConditionEquals {
    type: 'equals';
    column: string;
    value: unknown;
    caseInsensitive?: boolean;
}

export interface SQLiteConditionComparison {
    type: 'comparison';
    column: string;
    op: SQLiteComparisonOp;
    value: unknown;
}

export interface SQLiteConditionBetween {
    type: 'between';
    column: string;
    lower: unknown;
    upper: unknown;
    includeLower: boolean;
    includeUpper: boolean;
}

export interface SQLiteConditionIn {
    type: 'in';
    column: string;
    values: unknown[];
    caseInsensitive?: boolean;
}

export interface SQLiteConditionNotIn {
    type: 'notIn';
    column: string;
    values: unknown[];
}

export interface SQLiteConditionLike {
    type: 'like';
    column: string;
    pattern: string;
    caseInsensitive?: boolean;
}

export interface SQLiteConditionOr {
    type: 'or';
    conditions: SQLiteCondition[];
}

export type SQLiteCondition =
    | SQLiteConditionEquals
    | SQLiteConditionComparison
    | SQLiteConditionBetween
    | SQLiteConditionIn
    | SQLiteConditionNotIn
    | SQLiteConditionLike
    | SQLiteConditionOr;

export interface SQLiteCollectionState<T> {
    /**
     * OR groups of SQL conditions. Each group's conditions are ANDed together,
     * then groups are ORed: (A AND B) OR (C) OR (D AND E)
     */
    orGroups: SQLiteCondition[][];
    /** JavaScript predicate for conditions that can't be expressed in SQL (e.g., arbitrary filter functions) */
    jsPredicate?: (record: T, key: string, index: number) => boolean;
    orderBy?: { index: string | string[]; direction: 'asc' | 'desc' };
    reverse: boolean;
    offset: number;
    limit?: number;
    distinct: boolean;
}

export interface TableEntry<T> {
    key: string;
    value: T;
}

export interface SQLiteOrderByOptions {
    index: string | string[];
    direction: 'asc' | 'desc';
}

export interface SQLiteIterateEntriesOptions {
    orderBy?: SQLiteOrderByOptions;
    chunkSize?: number;
}

export interface SQLiteRunResult {
    changes?: number;
    lastId?: number;
}

export interface SQLiteQueryResult {
    columns?: string[];
    values?: any[][];
}

export interface SQLiteDatabaseDriver {
    readonly type: string;
    readonly name: string;
    open(): Promise<void>;
    close(): Promise<void>;
    execute(statement: string): Promise<void>;
    run(statement: string, values?: any[]): Promise<SQLiteRunResult>;
    query(statement: string, values?: any[]): Promise<SQLiteQueryResult>;
}

export interface SQLiteMigrationContext {
    execute: (statement: string) => Promise<void>;
    run: (statement: string, values?: any[]) => Promise<SQLiteRunResult>;
    query: (statement: string, values?: any[]) => Promise<SQLiteQueryResult>;
}

export type SQLiteMigrationHandler = (context: SQLiteMigrationContext) => Promise<void> | void;

export interface SQLiteVersionMigration {
    up?: SQLiteMigrationHandler;
    down?: SQLiteMigrationHandler;
}

export interface SQLiteSchemaDefinitionOptions {
    migrations?: SQLiteVersionMigration;
}

export interface StorageSchemaDefinitionOptions {
    sqlite?: SQLiteSchemaDefinitionOptions;
}
