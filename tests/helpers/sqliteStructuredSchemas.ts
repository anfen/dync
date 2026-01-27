import type { SQLiteColumnDefinition, SQLiteTableDefinition } from '../../src/storage/sqlite/schema';

const baseSyncColumns: Record<string, SQLiteColumnDefinition> = {
    name: { type: 'TEXT', nullable: true },
};

export const buildSQLiteSyncTableDefinition = (extraColumns: Record<string, SQLiteColumnDefinition> = {}): SQLiteTableDefinition => ({
    columns: {
        ...baseSyncColumns,
        ...extraColumns,
    },
});

export const sqliteCoverageUnsyncedDefinition: SQLiteTableDefinition = {
    columns: {
        id: { type: 'INTEGER' },
        info: { type: 'TEXT', nullable: true },
    },
};
