import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs to stderr, so stdout stays clean for the CLI result.
 * LOG_PRETTY=1 gives human-friendly output for local runs.
 */
export function createLogger(level = 'info', pretty = false): Logger {
  if (pretty) {
    return pino({
      level,
      base: { service: 'disputo' },
      transport: { target: 'pino-pretty', options: { destination: 2, colorize: true, ignore: 'pid,hostname,service' } },
    });
  }
  return pino({ level, base: { service: 'disputo' } }, pino.destination(2));
}

export const silentLogger = (): Logger => pino({ level: 'silent' });
