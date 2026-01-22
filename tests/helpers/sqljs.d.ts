declare module 'sql.js' {
    export interface SqlJsStatement {
        bind(values?: any[]): void;
        step(): boolean;
        get(): any[];
        getColumnNames(): string[];
        free(): void;
    }

    export interface SqlJsDatabase {
        prepare(statement: string): SqlJsStatement;
        exec(statement: string): Array<{ columns: string[]; values: any[][] }>;
        run(statement: string, params?: any[]): void;
        getRowsModified?(): number;
        close(): void;
    }

    export interface SqlJsStatic {
        Database: new (...args: any[]) => SqlJsDatabase;
    }

    export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;

    export type Database = SqlJsDatabase;
}
