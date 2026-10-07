import { simpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function verifyBundle(bundlePath: string, refsPath: string, manifestPath?: string) {
  console.log(`Verifying bundle: ${bundlePath}`);

  if (!fs.existsSync(bundlePath)) throw new Error(`Bundle not found: ${bundlePath}`);
  if (!fs.existsSync(refsPath)) throw new Error(`Refs not found: ${refsPath}`);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-'));
  const repoDir = path.join(tmpDir, 'restore.git');

  try {
    const git = simpleGit();
    
    // 1. Restore from bundle (dry-run clone equivalent)
    console.log(`Cloning bundle into ${repoDir}...`);
    await git.clone(path.resolve(bundlePath), repoDir, ['--mirror']);

    const repoGit = simpleGit(repoDir);

    // 2. git fsck
    console.log(`Running git fsck on restored bundle...`);
    const fsckResult = await repoGit.raw(['fsck', '--full']);
    console.log('fsck output:', fsckResult || 'clean');

    // 3. Verify Refs
    console.log(`Verifying refs match refs.json...`);
    const rawRefs = await repoGit.raw(['show-ref']);
    const actualRefs = rawRefs.trim().split('\n').filter(Boolean).map(line => {
      const [sha, ref] = line.split(' ');
      return { sha, ref };
    });

    const expectedRefs: { sha: string, ref: string }[] = JSON.parse(await fs.promises.readFile(refsPath, 'utf8'));

    const missingRefs = expectedRefs.filter(
      expected => !actualRefs.find(actual => actual.ref === expected.ref && actual.sha === expected.sha)
    );

    if (missingRefs.length > 0) {
      throw new Error(`Missing or mismatched refs in bundle: ${JSON.stringify(missingRefs)}`);
    }

    console.log(`All ${expectedRefs.length} refs verified.`);

    // 4. Verify Manifest Parses
    if (manifestPath && fs.existsSync(manifestPath)) {
      console.log('Verifying manifest.json parses...');
      const manifestObj = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      if (!manifestObj.artifacts || !manifestObj.captureMode) {
         throw new Error(`Manifest lacks required fields`);
      }
      console.log('Manifest is valid.');
    }

    console.log('Verification passed successfully! 🚀');

  } catch (err) {
    console.error('Verification failed ❌:', err);
    process.exit(1);
  } finally {
    // Cleanup
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: ts-node verify-bundle.ts <path-to-bundle> <path-to-refs.json> [path-to-manifest.json]');
  process.exit(1);
}

verifyBundle(args[0], args[1], args[2]);
