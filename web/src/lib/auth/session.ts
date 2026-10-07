import { jwtVerify, SignJWT } from 'jose';
import { cookies } from 'next/headers';

const secretKey = process.env.SESSION_SECRET;
const key = new TextEncoder().encode(secretKey);

export type SessionData = {
  githubToken?: string;
  githubUser?: {
    login: string;
    id: number;
    avatar_url: string;
  };
};

export async function encrypt(payload: SessionData, expires: Date) {
  if (!secretKey) throw new Error('SESSION_SECRET is not set');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
}

export async function decrypt(input: string): Promise<SessionData | null> {
  if (!secretKey) return null;
  try {
    const { payload } = await jwtVerify(input, key, { algorithms: ['HS256'] });
    return payload as SessionData;
  } catch (error) {
    return null;
  }
}

export async function getSession(): Promise<SessionData | null> {
  const sessionCookie = (await cookies()).get('session')?.value;
  if (!sessionCookie) return null;
  return decrypt(sessionCookie);
}

export async function setSession(data: SessionData) {
  const expires = new Date(Date.now() + 10 * 60 * 60 * 1000); // 10 hours
  const sessionCookie = await encrypt(data, expires);
  (await cookies()).set('session', sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path: '/',
  });
}

export async function clearSession() {
  (await cookies()).set('session', '', { expires: new Date(0), path: '/' });
}
