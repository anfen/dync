import { ApiError, SyncAction } from './types';
import { createLocalId } from './createLocalId';

export { createLocalId };

export function parseApiError(error: any): ApiError {
    if (error instanceof ApiError) {
        return error;
    }

    if (typeof error === 'string') {
        return new ApiError(error, false);
    }

    return new ApiError(error.message, isNetworkError(error), error);
}

/**
 * Detects if an error is a network-level failure from common HTTP libraries.
 * Supports: fetch, axios, Apollo GraphQL, and generic network errors.
 */
function isNetworkError(error: any): boolean {
    const message = error.message?.toLowerCase() ?? '';
    const name = error.name;

    // fetch: throws TypeError on network failure
    if (message.includes('failed to fetch') || message.includes('network request failed')) {
        return true;
    }

    // axios: sets error.code for network issues
    const code = error.code;
    if (code === 'ERR_NETWORK' || code === 'ECONNABORTED' || code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
        return true;
    }

    // axios: no response means request never reached server
    if (error.isAxiosError && error.response === undefined) {
        return true;
    }

    // Apollo GraphQL: network error wrapper
    if (name === 'ApolloError' && error.networkError) {
        return true;
    }

    // Generic network error messages
    if (message.includes('network error') || message.includes('networkerror')) {
        return true;
    }

    return false;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

export function changeKeysTo(input: any | any[], toIdKey: string, toUpdatedAtKey: string, toDeletedKey: string) {
    if (!input) return input;
    const isArray = Array.isArray(input);
    const result = (isArray ? input : [input]).map((item) => {
        const { id, updated_at, deleted, ...rest } = item;
        return {
            [toIdKey]: id,
            [toUpdatedAtKey]: updated_at,
            [toDeletedKey]: deleted,
            ...rest,
        };
    });
    return isArray ? result : result[0];
}

export function changeKeysFrom(input: any | any[], fromIdKey: string, fromUpdatedAtKey: string, fromDeletedKey: string) {
    if (!input) return input;
    const isArray = Array.isArray(input);
    const result = (isArray ? input : [input]).map((item) => {
        const { [fromIdKey]: id, [fromUpdatedAtKey]: updated_at, [fromDeletedKey]: deleted, ...rest } = item;
        return {
            id,
            updated_at,
            deleted,
            ...rest,
        };
    });
    return isArray ? result : result[0];
}

export function orderFor(a: SyncAction): number {
    switch (a) {
        case SyncAction.Create:
            return 1;
        case SyncAction.Update:
            return 2;
        case SyncAction.Remove:
            return 3;
    }
}

export function omitFields(item: any, fields: string[]) {
    const result = { ...item };
    for (const k of fields) delete result[k];
    return result;
}

export function addOnSetDo(obj: any, key: string, fn: (v: any) => void): void {
    let value = obj[key];

    Object.defineProperty(obj, key, {
        get() {
            return value;
        },
        set(newVal) {
            value = newVal;
            fn(value);
        },
        enumerable: true,
        configurable: false,
    });
}

export function deleteKeyIfEmptyObject(obj: any, key: string) {
    if (obj[key] && Object.keys(obj[key]).length === 0) {
        delete obj[key];
    }
}
