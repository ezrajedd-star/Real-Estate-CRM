import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { redact, scrubString } from './redact.js';

export type { Logger } from 'pino';

/**
 * Structured JSON logger with the PII redaction layer applied to every record: bound
 * objects go through `redact`, and message strings through `scrubString`. Use this logger
 * everywhere — `console.*` is banned by ESLint.
 */
export function createLogger(
  options: { name: string; level?: string } & Pick<LoggerOptions, 'base'>,
  destination?: DestinationStream,
): Logger {
  const opts: LoggerOptions = {
    name: options.name,
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: options.base ?? { service: options.name },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => redact(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrubString(a) : a));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (e: unknown) => redact(e),
      error: (e: unknown) => redact(e),
    },
  };
  return destination ? pino(opts, destination) : pino(opts);
}
