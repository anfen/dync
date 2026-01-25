import { describe, it, expect, vi } from 'vitest';
import { createLocalId, changeKeysTo, changeKeysFrom, orderFor, sleep, omitFields, addOnSetDo, deleteKeyIfEmptyObject } from '../../src/helpers';
import { SyncAction, ApiError, parseApiError } from '../../src/types';
import { Dync, MemoryAdapter } from '../../src/index';

// ============================================================================
// Pure helper function tests
// ============================================================================

describe('helpers', () => {
    describe('createLocalId', () => {
        it('generates a unique uuid-like string', () => {
            const first = createLocalId();
            const second = createLocalId();
            expect(typeof first).toBe('string');
            expect(typeof second).toBe('string');
            expect(first).not.toBe(second);
        });
    });

    describe('changeKeysTo / changeKeysFrom', () => {
        it('remaps keys on single object', () => {
            const source = { id: 1, updated_at: 'now', deleted: false, name: 'Item' };
            const remapped = changeKeysTo(source, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(remapped).toEqual({ remoteId: 1, remoteUpdatedAt: 'now', remoteDeleted: false, name: 'Item' });
            const roundTrip = changeKeysFrom(remapped, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(roundTrip).toEqual(source);
        });

        it('works on arrays', () => {
            const source = [
                { id: 1, updated_at: 'a', deleted: false },
                { id: 2, updated_at: 'b', deleted: true },
            ];
            const remapped = changeKeysTo(source, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(Array.isArray(remapped)).toBe(true);
            expect(remapped[0]).toHaveProperty('remoteId', 1);
            const roundTrip = changeKeysFrom(remapped, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(roundTrip).toEqual(source);
        });
    });

    describe('orderFor', () => {
        it('returns priority numbers for sync actions', () => {
            expect(orderFor(SyncAction.Create)).toBe(1);
            expect(orderFor(SyncAction.Update)).toBe(2);
            expect(orderFor(SyncAction.Remove)).toBe(3);
        });
    });

    describe('sleep', () => {
        it('resolves after specified milliseconds', async () => {
            vi.useFakeTimers();
            try {
                const sleeper = sleep(1000);
                const resolveSpy = vi.fn();

                sleeper.then(resolveSpy);

                await vi.advanceTimersByTimeAsync(999);
                expect(resolveSpy).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(1);
                expect(resolveSpy).toHaveBeenCalledTimes(1);

                await sleeper;
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('omitFields', () => {
        it('returns a shallow copy without specified fields', () => {
            const source = { id: 1, secret: 'hidden', name: 'visible' };
            const result = omitFields(source, ['secret']);

            expect(result).toEqual({ id: 1, name: 'visible' });
            expect(source).toHaveProperty('secret', 'hidden');
            expect(result).not.toBe(source);
        });
    });

    describe('addOnSetDo', () => {
        it('invokes callback every time the property is set', () => {
            const obj: { value?: number } = { value: 1 };
            const callback = vi.fn();

            addOnSetDo(obj, 'value', callback);

            obj.value = 2;
            obj.value = 3;

            expect(callback).toHaveBeenNthCalledWith(1, 2);
            expect(callback).toHaveBeenNthCalledWith(2, 3);
            expect(obj.value).toBe(3);
        });
    });

    describe('deleteKeyIfEmptyObject', () => {
        it('removes key when value is an empty object', () => {
            const target: Record<string, unknown> = { keep: { a: 1 }, remove: {} };

            deleteKeyIfEmptyObject(target, 'remove');
            deleteKeyIfEmptyObject(target, 'keep');

            expect(target).toEqual({ keep: { a: 1 } });
            expect('remove' in target).toBe(false);
        });

        it('leaves key when value is nullish or populated', () => {
            const target: Record<string, unknown> = { nil: null, nested: { a: 1 } };

            deleteKeyIfEmptyObject(target, 'nil');
            deleteKeyIfEmptyObject(target, 'nested');

            expect(target).toEqual({ nil: null, nested: { a: 1 } });
        });
    });
});

// ============================================================================
// Dync reactive helpers tests
// ============================================================================

describe('Dync reactive helpers', () => {
    const createSilentLogger = () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    });

    it('notifies onSyncStateChange listeners when syncStatus updates', async () => {
        const dbName = 'reactive-onSyncStateChange';
        const db = new Dync(dbName, {}, new MemoryAdapter(dbName), { logger: createSilentLogger(), minLogLevel: 'none' });
        const listener = vi.fn();
        const unsubscribe = db.sync.onStateChange(listener);

        (db as any).syncStatus = 'syncing';
        (db as any).syncStatus = 'idle';

        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'syncing' }));
        expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'idle' }));

        unsubscribe();
        (db as any).syncStatus = 'disabled';
        expect(listener).toHaveBeenCalledTimes(2);

        await db.close();
    });

    it('addOnSetDo defines accessors and invokes callback on assignment', async () => {
        const dbName = 'reactive-addOnSetDo';
        const db = new Dync(dbName, {}, new MemoryAdapter(dbName), { logger: createSilentLogger(), minLogLevel: 'none' });
        const target: { value: number } = { value: 1 };
        const callback = vi.fn();

        addOnSetDo(target, 'value', callback);

        const descriptor = Object.getOwnPropertyDescriptor(target, 'value');
        expect(typeof descriptor?.get).toBe('function');
        expect(typeof descriptor?.set).toBe('function');

        expect(target.value).toBe(1);
        target.value = 42;
        expect(callback).toHaveBeenCalledWith(42);
        expect(target.value).toBe(42);

        target.value = 99;
        expect(callback).toHaveBeenLastCalledWith(99);

        await db.close();
    });
});

// ============================================================================
// ApiError and parseApiError tests
// ============================================================================

describe('ApiError', () => {
    it('constructs with message, isNetworkError, and cause', () => {
        const cause = new Error('original');
        const apiError = new ApiError('Something failed', true, cause);

        expect(apiError.message).toBe('Something failed');
        expect(apiError.isNetworkError).toBe(true);
        expect(apiError.cause).toBe(cause);
        expect(apiError.name).toBe('ApiError');
        expect(apiError).toBeInstanceOf(Error);
    });
});

describe('parseApiError', () => {
    it('returns the same ApiError if already an ApiError', () => {
        const original = new ApiError('test', true);
        const parsed = parseApiError(original);
        expect(parsed).toBe(original);
    });

    it('converts a regular Error to ApiError with isNetworkError=false', () => {
        const error = new Error('Something went wrong');
        const parsed = parseApiError(error);

        expect(parsed).toBeInstanceOf(ApiError);
        expect(parsed.message).toBe('Something went wrong');
        expect(parsed.isNetworkError).toBe(false);
        expect(parsed.cause).toBe(error);
    });

    it('converts non-Error values to ApiError', () => {
        const parsed = parseApiError('string error');
        expect(parsed).toBeInstanceOf(ApiError);
        expect(parsed.message).toBe('string error');
        expect(parsed.isNetworkError).toBe(false);
    });

    describe('network error detection', () => {
        it('detects fetch TypeError "Failed to fetch"', () => {
            const error = new TypeError('Failed to fetch');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects fetch TypeError "Network request failed" (React Native)', () => {
            const error = new TypeError('Network request failed');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects axios ERR_NETWORK code', () => {
            const error = new Error('Network Error') as any;
            error.code = 'ERR_NETWORK';
            error.isAxiosError = true;
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects axios ECONNABORTED code (timeout)', () => {
            const error = new Error('timeout of 5000ms exceeded') as any;
            error.code = 'ECONNABORTED';
            error.isAxiosError = true;
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects axios ENOTFOUND code (DNS failure)', () => {
            const error = new Error('getaddrinfo ENOTFOUND example.com') as any;
            error.code = 'ENOTFOUND';
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects axios ECONNREFUSED code', () => {
            const error = new Error('connect ECONNREFUSED 127.0.0.1:3000') as any;
            error.code = 'ECONNREFUSED';
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects axios error with no response (network level failure)', () => {
            const error = new Error('Network Error') as any;
            error.isAxiosError = true;
            error.response = undefined;
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('does NOT flag axios error with response as network error', () => {
            const error = new Error('Request failed with status code 500') as any;
            error.isAxiosError = true;
            error.response = { status: 500, data: {} };
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(false);
        });

        it('detects Apollo GraphQL network error', () => {
            const error = new Error('Network error') as any;
            error.name = 'ApolloError';
            error.networkError = new Error('Failed to fetch');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('does NOT flag Apollo GraphQL error without networkError', () => {
            const error = new Error('GraphQL error') as any;
            error.name = 'ApolloError';
            error.graphQLErrors = [{ message: 'Validation failed' }];
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(false);
        });

        it('detects generic "network error" message', () => {
            const error = new Error('A network error occurred');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('detects generic "NetworkError" message (case insensitive)', () => {
            const error = new Error('NetworkError when attempting to fetch resource');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(true);
        });

        it('does NOT flag regular server errors as network errors', () => {
            const error = new Error('Internal Server Error');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(false);
        });

        it('does NOT flag validation errors as network errors', () => {
            const error = new Error('Validation failed: name is required');
            const parsed = parseApiError(error);
            expect(parsed.isNetworkError).toBe(false);
        });
    });
});
