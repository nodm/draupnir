import type { PreSignUpTriggerHandler } from 'aws-lambda';

export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

export function isAllowlisted(
  email: string | undefined,
  allowlist: Set<string>,
): boolean {
  return email !== undefined && allowlist.has(email.toLowerCase());
}

export const handler: PreSignUpTriggerHandler = async (event) => {
  const allowlist = parseAllowlist(process.env.ALLOWLISTED_EMAILS);
  const email = event.request.userAttributes.email;

  if (!isAllowlisted(email, allowlist)) {
    throw new Error(
      `PreSignUp rejected: ${email ?? '(no email)'} is not on the allowlist`,
    );
  }

  return event;
};
