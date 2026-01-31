import { SQLiteAdapter } from './SQLiteAdapter';

export class SQLiteQueryContext {
    constructor(private readonly adapter: SQLiteAdapter) {}

    async queryRows(statement: string, values?: any[]): Promise<Array<Record<string, any>>> {
        return this.adapter.queryRows(statement, values);
    }
}
