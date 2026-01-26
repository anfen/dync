import type { SQLiteCollectionState, SQLiteCondition } from './types';

export const SQLITE_SCHEMA_VERSION_STATE_KEY = 'sqlite_schema_version';
export const DEFAULT_STREAM_BATCH_SIZE = 200;

export const createDefaultState = <T>(): SQLiteCollectionState<T> => ({
    orGroups: [[]],
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

export const buildWhereClause = (orGroups: SQLiteCondition[][]): SQLiteBuiltQuery => {
    // Filter out empty groups
    const nonEmptyGroups = orGroups.filter((group) => group.length > 0);

    if (nonEmptyGroups.length === 0) {
        return { whereClause: '', parameters: [] };
    }

    const groupClauses: string[] = [];
    const parameters: unknown[] = [];

    for (const group of nonEmptyGroups) {
        const conditionClauses: string[] = [];
        for (const condition of group) {
            const built = buildCondition(condition);
            conditionClauses.push(built.clause);
            parameters.push(...built.parameters);
        }
        // AND conditions within a group
        const groupClause = conditionClauses.length === 1 ? conditionClauses[0]! : `(${conditionClauses.join(' AND ')})`;
        groupClauses.push(groupClause);
    }

    // OR between groups (wrap in parens if multiple groups)
    const whereContent = groupClauses.length === 1 ? groupClauses[0]! : `(${groupClauses.join(' OR ')})`;

    return {
        whereClause: `WHERE ${whereContent}`,
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

    const col = quoteIdentifier(condition.column);

    switch (condition.type) {
        case 'equals': {
            if (condition.caseInsensitive) {
                // COLLATE NOCASE is more efficient than LOWER() as it can use indexes
                return { clause: `${col} = ? COLLATE NOCASE`, parameters: [condition.value] };
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
                    clause: `${col} COLLATE NOCASE IN (${placeholders})`,
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
                // LIKE is case-insensitive by default for ASCII in SQLite
                return { clause: `${col} LIKE ?`, parameters: [condition.pattern] };
            }
            // GLOB is case-sensitive - convert LIKE wildcards (% → *, _ → ?)
            const globPattern = condition.pattern.replace(/%/g, '*').replace(/_/g, '?');
            return { clause: `${col} GLOB ?`, parameters: [globPattern] };
        }
    }
};

export const cloneValue = <T>(value: T): T => {
    // Fast path for null/undefined/primitives
    if (value == null || typeof value !== 'object') return value;

    // Fast path for flat objects (common case for SQLite records)
    if (!Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
        const obj = value as Record<string, unknown>;
        let isFlat = true;
        for (const key in obj) {
            const v = obj[key];
            if (v !== null && typeof v === 'object') {
                isFlat = false;
                break;
            }
        }
        if (isFlat) return { ...obj } as T;
    }

    // Deep clone for arrays/nested objects
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
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
