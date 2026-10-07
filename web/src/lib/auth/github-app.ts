import { createAppAuth } from '@octokit/auth-app';

export async function getInstallationToken(targetName: string, targetType: 'org' | 'user'): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    return null; // App auth not configured
  }

  try {
    const auth = createAppAuth({
      appId,
      privateKey,
    });

    // First we must find the installation ID for the target org/user
    // We authenticate as the App itself using JWT
    const appAuth = await auth({ type: 'app' });

    const apiUrl = targetType === 'org' 
      ? `https://api.github.com/orgs/${targetName}/installation`
      : `https://api.github.com/users/${targetName}/installation`;

    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${appAuth.token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`GitHub App is not installed for ${targetType} '${targetName}'.`);
      }
      throw new Error(`Failed to fetch installation for ${targetName}: ${res.statusText}`);
    }

    const installation = await res.json();

    // Now request an installation token
    const installationAuth = await auth({
      type: 'installation',
      installationId: installation.id,
    });

    return installationAuth.token;
  } catch (err) {
    console.error('GitHub App Auth Error:', err);
    throw err;
  }
}
