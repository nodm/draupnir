export class UnauthenticatedError extends Error {
  constructor() {
    super('Authenticated request is missing a sub claim');
    this.name = 'UnauthenticatedError';
  }
}

export function requireSub(claims: { [name: string]: string }): string {
  const sub = claims['sub'];
  if (!sub) {
    throw new UnauthenticatedError();
  }
  return sub;
}
