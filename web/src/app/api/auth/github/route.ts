import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return new Response('GITHUB_CLIENT_ID not configured', { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const returnTo = searchParams.get('returnTo') || '/';

  // We could use a proper state parameter in production
  const state = Buffer.from(JSON.stringify({ returnTo })).toString('base64');

  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', clientId);
  githubUrl.searchParams.set('state', state);
  
  // Note: For GitHub App, 'scope' is not used, permissions are defined by the app installation.
  // But if it's an OAuth app, we would request scopes here.
  
  return NextResponse.redirect(githubUrl.toString());
}
