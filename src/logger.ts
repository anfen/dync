export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

export function newLogger(base: Logger, min: LogLevel): Logger {
    const order: Record<LogLevel, number> = {
        debug: 10,
        info: 20,
        warn: 30,
        error: 40,
        none: 100,
    };
    const threshold = order[min];
    const enabled = (lvl: LogLevel) => order[lvl] >= threshold;
    return {
        debug: (...a: any[]) => enabled('debug') && base.debug?.(...a),
        info: (...a: any[]) => enabled('info') && base.info?.(...a),
        warn: (...a: any[]) => enabled('warn') && base.warn?.(...a),
        error: (...a: any[]) => enabled('error') && base.error?.(...a),
    };
}
