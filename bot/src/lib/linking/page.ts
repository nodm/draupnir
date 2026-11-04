const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Telegram display names are attacker-controlled (anyone can message the bot),
// so everything interpolated into the page is escaped.
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
.code{font-size:2.5rem;letter-spacing:.3em;font-weight:700;margin:1rem 0}
.warn{border-left:4px solid #b00020;padding-left:.75rem}</style>
</head><body>${body}</body></html>`;
}

export function codePage(input: {
  displayName: string;
  username: string | null;
  code: string;
  botUsername: string;
}): string {
  const who = input.username
    ? `${escapeHtml(input.displayName)} (@${escapeHtml(input.username)})`
    : escapeHtml(input.displayName);
  return layout(
    'Confirm your Telegram link',
    `<h1>One more step</h1>
<p>The Telegram account <strong>${who}</strong> asked to link to the Google account you just signed in with.</p>
<p>To finish, send this code to <strong>@${escapeHtml(input.botUsername)}</strong> from that Telegram account within 5 minutes:</p>
<div class="code">${escapeHtml(input.code)}</div>
<p class="warn"><strong>Never share this code with anyone.</strong> If you did not ask to link a Telegram account, close this page; nothing was linked.</p>`,
  );
}

export const messagePage = (title: string, text: string): string =>
  layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);

export const EXPIRED_PAGE = messagePage(
  'Link expired',
  'This sign-in link has expired or was already used. Go back to the bot and send /start for a new one.',
);

export const FAILED_PAGE = messagePage(
  'Sign-in failed',
  'We could not complete the sign-in. Go back to the bot and send /start to try again.',
);

export const ALREADY_LINKED_PAGE = messagePage(
  'Already linked',
  'That Google account or Telegram account is already linked. Send /unlink from the linked chat first, then try again.',
);
