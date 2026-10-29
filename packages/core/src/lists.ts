/**
 * Static reference lists. Small enough to keep in code; the disposable list is
 * large and lives in data/disposable-domains.txt.
 */

/** Consumer mailbox providers. Flagged as `free`, which matters for B2B outreach. */
export const FREE_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com',
  'rocketmail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'mail.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'zohomail.in', 'yandex.com',
  'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'rediffmail.com', 'tutanota.com',
  'fastmail.com', 'hey.com', 'inbox.com', 'naver.com', 'daum.net', 'libero.it', 'orange.fr',
  'free.fr', 'laposte.net', 't-online.de', 'btinternet.com', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'cox.net', 'charter.net',
]);

/**
 * Local parts that address a function rather than a person. They usually exist,
 * but outreach to them converts poorly and draws complaints.
 */
export const ROLE_LOCALS: ReadonlySet<string> = new Set([
  'abuse', 'accounts', 'accounting', 'admin', 'administrator', 'all', 'billing', 'careers',
  'ceo', 'compliance', 'contact', 'contactus', 'contact-us', 'customercare', 'customerservice',
  'dev', 'devnull', 'dns', 'enquiries', 'enquiry', 'everyone', 'finance', 'ftp', 'hello', 'help',
  'helpdesk', 'hi', 'hostmaster', 'hr', 'info', 'inquiries', 'inquiry', 'investors', 'it',
  'jobs', 'legal', 'mail', 'mailer-daemon', 'marketing', 'media', 'news', 'newsletter',
  'no-reply', 'noreply', 'do-not-reply', 'donotreply', 'office', 'ops', 'orders', 'postmaster',
  'press', 'privacy', 'recruiting', 'recruitment', 'root', 'sales', 'security', 'service',
  'staff', 'support', 'team', 'tech', 'webmaster', 'www',
]);

/**
 * Typo-correction targets, most common first so ties resolve to the likelier
 * provider. Domains in this list are never "corrected" themselves.
 */
export const POPULAR_DOMAINS: readonly string[] = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com',
  'live.com', 'msn.com', 'yahoo.co.in', 'rediffmail.com', 'protonmail.com', 'proton.me',
  'zoho.com', 'gmx.com', 'mail.com', 'me.com', 'mac.com', 'yandex.com', 'qq.com',
  'googlemail.com', 'hotmail.co.uk', 'yahoo.co.uk', 'comcast.net', 'verizon.net', 'att.net',
];

/** Common top-level-domain typos for domains not covered by POPULAR_DOMAINS. */
export const TLD_TYPOS: Readonly<Record<string, string>> = {
  con: 'com', cmo: 'com', ocm: 'com', vom: 'com', xom: 'com', comm: 'com', coom: 'com',
  cpm: 'com', copm: 'com', om: 'com', ne: 'net', nte: 'net', nett: 'net', ogr: 'org',
  orgg: 'org', rog: 'org',
};
