import type { SQLiteCollectionState, SQLiteCondition } from './types';

export const SQLITE_SCHEMA_VERSION_STATE_KEY = 'sqlite_schema_version';
export const DEFAULT_STREAM_BATCH_SIZE = 200;

export const createDefaultState = <T>(): SQLiteCollectionState<T> => ({
    sqlConditions: [],
    jsPredicate: undefined,
    orderBy: undefined,
    reverse: false,
    offset: 0,
    limit: undefined,
    distinct: false,
});

export interface SQLiteBuiltQuery {
    whereClause: string;
    parameters: unknown[];
}

export const buildWhereClause = (conditions: SQLiteCondition[]): SQLiteBuiltQuery => {
    if (conditions.length === 0) {
        return { whereClause: '', parameters: [] };
    }

    const clauses: string[] = [];
    const parameters: unknown[] = [];

    for (const condition of conditions) {
        const built = buildCondition(condition);
        clauses.push(built.clause);
        parameters.push(...built.parameters);
    }

    return {
        whereClause: `WHERE ${clauses.join(' AND ')}`,
        parameters,
    };
};

interface BuiltCondition {
    clause: string;
    parameters: unknown[];
}

const buildCondition = (condition: SQLiteCondition): BuiltCondition => {
    // Handle 'or' condition first since it doesn't have a column property
    if (condition.type === 'or') {
        if (condition.conditions.length === 0) {
            return { clause: '0 = 1', parameters: [] };
        }
        const subClauses: string[] = [];
        const subParams: unknown[] = [];
        for (const sub of condition.conditions) {
            const built = buildCondition(sub);
            subClauses.push(built.clause);
            subParams.push(...built.parameters);
        }
        return { clause: `(${subClauses.join(' OR ')})`, parameters: subParams };
    }

    // Handle compound equals (multiple columns ANDed together)
    if (condition.type === 'compoundEquals') {
        const clauses = condition.columns.map((col) => `${quoteIdentifier(col)} = ?`);
        return { clause: `(${clauses.join(' AND ')})`, parameters: condition.values };
    }

    const col = quoteIdentifier(condition.column);

    switch (condition.type) {
        case 'equals': {
            if (condition.caseInsensitive) {
                return { clause: `LOWER(${col}) = LOWER(?)`, parameters: [condition.value] };
            }
            return { clause: `${col} = ?`, parameters: [condition.value] };
        }

        case 'comparison': {
            return { clause: `${col} ${condition.op} ?`, parameters: [condition.value] };
        }

        case 'between': {
            const lowerOp = condition.includeLower ? '>=' : '>';
            const upperOp = condition.includeUpper ? '<=' : '<';
            return {
                clause: `(${col} ${lowerOp} ? AND ${col} ${upperOp} ?)`,
                parameters: [condition.lower, condition.upper],
            };
        }

        case 'in': {
            if (condition.values.length === 0) {
                // No values = no matches
                return { clause: '0 = 1', parameters: [] };
            }
            const placeholders = condition.values.map(() => '?').join(', ');
            if (condition.caseInsensitive) {
                return {
                    clause: `LOWER(${col}) IN (${condition.values.map(() => 'LOWER(?)').join(', ')})`,
                    parameters: condition.values,
                };
            }
            return { clause: `${col} IN (${placeholders})`, parameters: condition.values };
        }

        case 'notIn': {
            if (condition.values.length === 0) {
                // No exclusions = all match
                return { clause: '1 = 1', parameters: [] };
            }
            const placeholders = condition.values.map(() => '?').join(', ');
            return { clause: `${col} NOT IN (${placeholders})`, parameters: condition.values };
        }

        case 'like': {
            if (condition.caseInsensitive) {
                return { clause: `LOWER(${col}) LIKE LOWER(?)`, parameters: [condition.pattern] };
            }
            return { clause: `${col} LIKE ?`, parameters: [condition.pattern] };
        }
    }
};

export const cloneValue = <T>(value: T): T => {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value ?? null)) as T;
};

export const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export const normalizeComparableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeComparableValue(entry));
    }
    if (value instanceof Date) {
        return value.valueOf();
    }
    if (value === undefined) {
        return null;
    }
    return value;
};
