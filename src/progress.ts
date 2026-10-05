// Gap 6: Progress bar
import { MultiBar, Presets, type SingleBar } from 'cli-progress';

export class ProgressManager {
  private multi: MultiBar;
  private repoBar: SingleBar;
  private fileBar: SingleBar | null = null;

  constructor(totalRepos: number) {
    this.multi = new MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: ' {bar} {percentage}% | {value}/{total} | {label}',
        stream: process.stderr,
      },
      Presets.shades_grey
    );
    this.repoBar = this.multi.create(totalRepos, 0, { label: 'repos' });
  }

  startRepo(name: string, totalFiles: number): void {
    if (this.fileBar) {
      this.multi.remove(this.fileBar);
    }
    this.fileBar = this.multi.create(totalFiles, 0, { label: name });
  }

  tickFile(): void {
    this.fileBar?.increment();
  }

  tickRepo(): void {
    this.repoBar.increment();
    if (this.fileBar) {
      this.multi.remove(this.fileBar);
      this.fileBar = null;
    }
  }

  log(msg: string): void {
    this.multi.log(msg + '\n');
  }

  stop(): void {
    this.multi.stop();
  }
}

export function shouldUseProgress(): boolean {
  return process.stderr.isTTY === true && !process.env.CI;
}
