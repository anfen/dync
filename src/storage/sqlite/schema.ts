export type TableSchemaDefinition = string | SQLiteTableDefinition;

export interface SQLiteTableDefinition {
    columns: Record<string, SQLiteColumnDefinition>;
    indexes?: SQLiteIndexDefinition[];
    tableConstraints?: string[];
    withoutRowId?: boolean;
    strict?: boolean;
}

export interface SQLiteColumnDefinition {
    type?: string;
    length?: number;
    nullable?: boolean;
    unique?: boolean;
    default?: SQLiteDefaultValue;
    check?: string;
    references?: SQLiteForeignKeyReference | string;
    collate?: string;
    generatedAlwaysAs?: string;
    stored?: boolean;
    constraints?: string[];
}

export type SQLiteDefaultValue = string | number | boolean | null;

export interface SQLiteForeignKeyReference {
    table: string;
    column?: string;
    onDelete?: SQLiteForeignKeyAction;
    onUpdate?: SQLiteForeignKeyAction;
    match?: string;
}

export type SQLiteForeignKeyAction = 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION' | 'CASCADE';

export interface SQLiteIndexDefinition {
    name?: string;
    columns: string[];
    unique?: boolean;
    where?: string;
    collate?: string;
    orders?: Array<'ASC' | 'DESC'>;
}
