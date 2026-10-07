import { NextResponse } from 'next/server';
import { setSession } from '@/lib/auth/session';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const stateStr = searchParams.get('state');

  if (!code) {
    return new Response('No code provided', { status: 400 });
  }

  let returnTo = '/';
  if (stateStr) {
    try {
      const state = JSON.parse(Buffer.from(stateStr, 'base64').toString());
      if (state.returnTo && typeof state.returnTo === 'string' && state.returnTo.startsWith('/')) {
        returnTo = state.returnTo;
      }
    } catch (e) {
      // ignore invalid state
    }
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response('GitHub OAuth not configured', { status: 500 });
  }

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) {
    return new Response(`OAuth Error: ${tokenData.error_description || tokenData.error}`, { status: 400 });
  }

  const accessToken = tokenData.access_token;

  // Fetch user profile
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!userRes.ok) {
    return new Response('Failed to fetch user profile', { status: 500 });
  }

  const user = await userRes.json();

  // Create session
  await setSession({
    githubToken: accessToken,
    githubUser: {
      login: user.login,
      id: user.id,
      avatar_url: user.avatar_url,
    },
  });

  return NextResponse.redirect(new URL(returnTo, req.url));
}
