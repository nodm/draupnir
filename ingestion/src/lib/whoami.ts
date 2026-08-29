export interface WhoamiClaims {
  sub: string;
  email: string;
}

export function extractWhoamiClaims(claims: {
  [name: string]: string;
}): WhoamiClaims {
  const { sub, email } = claims;

  if (!sub || !email) {
    throw new Error('Authenticated request is missing sub/email claims');
  }

  return { sub, email };
}
