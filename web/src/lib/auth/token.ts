import { getSession } from './session';
import { getInstallationToken } from './github-app';

export async function resolveGitHubToken(pat: string | undefined, targetName: string, targetType: 'org' | 'user'): Promise<string | null> {
  // 1. Explicit PAT from payload has highest precedence
  if (pat && pat.trim().length > 0) {
    return pat.trim();
  }

  // 2. GitHub App Installation Token
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
    try {
      const appToken = await getInstallationToken(targetName, targetType);
      if (appToken) {
        return appToken;
      }
    } catch (err) {
      console.warn(`[auth] GitHub App token failed for ${targetType} ${targetName}:`, err);
      // Fallback to session token
    }
  }

  // 3. User OAuth Session Token
  const session = await getSession();
  if (session?.githubToken) {
    return session.githubToken;
  }

  return null;
}
