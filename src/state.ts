// Gap 3: Resume on interrupt + Gap 4: Incremental sync state
// Zero-native JSON file — works on any Node.js version

import fs from 'fs';

type UploadEntry = { sha: string; adapters: string[]; ts: number };
type RepoHeadEntry = { sha: string; ts: number };
type StateData = {
  uploads: Record<string, UploadEntry>;
  repoHeads: Record<string, RepoHeadEntry>;
};

export class StateManager {
  private data: StateData;
  private dirty = false;

  constructor(private readonly dbPath: string) {
    this.data = this.load();
  }

  private load(): StateData {
    if (fs.existsSync(this.dbPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.dbPath, 'utf8')) as StateData;
      } catch {
        console.warn('[state] Corrupt state file — starting fresh');
      }
    }
    return { uploads: {}, repoHeads: {} };
  }

  isUploaded(owner: string, repo: string, filePath: string, sha: string, adapterNames: string[]): boolean {
    const key = `${owner}/${repo}/${filePath}`;
    const entry = this.data.uploads[key];
    if (!entry || entry.sha !== sha) return false;
    return adapterNames.every((a) => entry.adapters.includes(a));
  }

  markUploaded(owner: string, repo: string, filePath: string, sha: string, adapterNames: string[]): void {
    this.data.uploads[`${owner}/${repo}/${filePath}`] = { sha, adapters: adapterNames, ts: Date.now() };
    this.dirty = true;
  }

  getRepoHead(owner: string, repo: string): string | null {
    return this.data.repoHeads[`${owner}/${repo}`]?.sha ?? null;
  }

  setRepoHead(owner: string, repo: string, headSha: string): void {
    this.data.repoHeads[`${owner}/${repo}`] = { sha: headSha, ts: Date.now() };
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    const tmp = this.dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dbPath);
    this.dirty = false;
  }

  stats(): { uploads: number; repos: number } {
    return {
      uploads: Object.keys(this.data.uploads).length,
      repos: Object.keys(this.data.repoHeads).length,
    };
  }
}
