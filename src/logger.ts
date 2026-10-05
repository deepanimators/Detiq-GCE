import fs from 'fs';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

class Logger {
  private fileStream: fs.WriteStream | null = null;

  init(logFilePath?: string): void {
    if (logFilePath) {
      this.fileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
      this.info(`Log started: ${new Date().toISOString()}`);
    }
  }

  private write(level: LogLevel, msg: string): void {
    const line = `[${level.toUpperCase()}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.fileStream?.write(line + '\n');
  }

  info(msg: string): void { this.write('info', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  error(msg: string): void { this.write('error', msg); }
  debug(msg: string): void { if (process.env.DEBUG) this.write('debug', msg); }

  close(): void { this.fileStream?.end(); }
}

export const logger = new Logger();
