/**
 * Gmail MCP — read and send mail over Google's free REST API.
 *
 * No SDK, no key, no billing: an OAuth token from bridge/auth.mjs (a personal
 * Google account, tokens kept server-side) plus plain HTTPS fetch against
 * gmail.googleapis.com. Everything answers "not connected" until the user
 * authorises, and that state is a message, not a crash.
 *
 * Tools: gmail_status (read), gmail_list (read), gmail_search (read),
 * gmail_read (read), gmail_send (write).
 */

import { googleFetch, googleAuthStatus, googleAuthUrl } from './auth.mjs'

/** Fold the base64url Gmail uses for its payloads. */
function base64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url')
}

/** Headers we actually want from a message. */
function headers(msg) {
  const get = (name) => msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
  return {
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
  }
}

/** The plain-text body of a message, walking nested parts. */
function bodyText(msg) {
  const collect = (part, acc) => {
    if (part?.parts) {
      for (const p of part.parts) collect(p, acc)
      return acc
    }
    if (part?.mimeType === 'text/plain' && part.body?.data) {
      acc.push(Buffer.from(part.body.data, 'base64').toString('utf8'))
    }
    return acc
  }
  return collect(msg.payload, []).join('\n')
}

async function listMessages(query, max) {
  const q = new URLSearchParams({ q: query ?? '', maxResults: String(max) })
  const page = await googleFetch(`/gmail/v1/users/me/messages?${q}`)
  const ids = (page.messages ?? []).slice(0, max).map((m) => m.id)
  const out = []
  for (const id of ids) {
    try {
      const m = await googleFetch(
        `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      )
      const h = headers(m)
      out.push({
        id: m.id,
        from: h.from,
        subject: h.subject || '(no subject)',
        date: h.date,
        snippet: m.snippet ?? '',
      })
    } catch {
      out.push({ id, from: '', subject: '(could not load)', date: '', snippet: '' })
    }
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Fast-path helpers for the command router.
 *
 * The MCP tools above are how the model reads mail. These are the same REST
 * reads framed for the router, which answers "any new mail?" in milliseconds
 * without booting the brain. Plain strings, ready to be spoken. The auth
 * guard returns a sentence rather than throwing, exactly as the tools do.
 * ------------------------------------------------------------------------- */

/** Unread count plus the first few senders/subjects. */
export async function gmailUnread(max = 5) {
  const h = googleAuthStatus()
  if (!h.configured) {
    return 'Gmail is not set up — no Google client id is configured.'
  }
  if (!h.connected) {
    return 'Gmail is not connected. Say "connect google" and complete the consent page.'
  }
  const items = await listMessages('is:unread', 12)
  if (!items.length) return 'Your inbox is clear, sir — nothing unread.'
  const count = items.length
  const spoken = items
    .slice(0, Math.max(1, max))
    .map((m) => `${m.from || 'unknown'}: ${m.subject}`)
    .join('. ')
  return `You have ${count} unread ${count === 1 ? 'message' : 'messages'}. ${spoken}.`
}

/** Sender, subject and the start of the newest message, said out loud. */
export async function gmailLatest() {
  const h = googleAuthStatus()
  if (!h.configured) {
    return 'Gmail is not set up — no Google client id is configured.'
  }
  if (!h.connected) {
    return 'Gmail is not connected. Say "connect google" and complete the consent page.'
  }
  const items = await listMessages('', 1)
  if (!items.length) return 'Your inbox is empty, sir.'
  const m = await googleFetch(`/gmail/v1/users/me/messages/${items[0].id}?format=full`)
  const hd = headers(m)
  const body = bodyText(m).replace(/\s+/g, ' ').trim()
  const MAX = 500
  return `${hd.from || 'Unknown sender'}: ${hd.subject || '(no subject)'}. ${body.slice(0, MAX)}${body.length > MAX ? '…' : ''}`
}

/** Matching messages for a spoken search, speaker-friendly. */
export async function gmailSearch(q) {
  const query = String(q ?? '').trim()
  if (!query) return 'What should I look for in your mail?'
  const h = googleAuthStatus()
  if (!h.configured) {
    return 'Gmail is not set up — no Google client id is configured.'
  }
  if (!h.connected) {
    return 'Gmail is not connected. Say "connect google" and complete the consent page.'
  }
  const items = await listMessages(query, 5)
  if (!items.length) return `I found nothing matching ${query}.`
  return items.map((m) => `${m.from || 'unknown'}: ${m.subject}`).join('. ')
}

export function gmailServer() {
  const health = () => googleAuthStatus()

  const reply = (s) => s

  return {
    tools: [
      {
        name: 'gmail_status',
        description:
          'Whether Gmail is connected and what it can do. Call before acting on ' +
          'mail if the user has not connected Gmail before, or when a mail action fails.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const h = health()
          if (!h.configured) {
            return 'Gmail is not set up — no Google client id is configured ' +
              '(set JARVIS_GOOGLE_CLIENT_ID and JARVIS_GOOGLE_CLIENT_SECRET, then "connect google").'
          }
          if (!h.connected) {
            return 'Gmail is not connected. Say "connect google" and complete ' +
              'the consent in the browser that opens.'
          }
          try {
            // OAuth can succeed while the Gmail API itself is disabled in
            // Google Cloud. Probe only the mailbox profile; never fetch mail
            // content from a status check.
            await googleFetch('/gmail/v1/users/me/profile')
            return `Gmail is connected and responding (${h.scopes.length} Google scopes).`
          } catch (error) {
            return `Google sign-in is connected, but Gmail is unavailable: ${error?.message ?? error}`
          }
        },
      },
      {
        name: 'gmail_list',
        description:
          'The most recent messages in the inbox — who wrote, the subject, when. ' +
          'Use for "any new mail", "what is in my inbox", or a quick summary of ' +
          'recent messages.',
        inputSchema: {
          type: 'object',
          properties: {
            max: { type: 'number', description: 'How many to show (default 8, max 20).' },
            query: { type: 'string', description: 'Optional Gmail filter, e.g. "from:github" or "is:unread".' },
          },
          required: [],
        },
        handler: async (args) => {
          const max = Math.min(20, Math.max(1, Number(args?.max) || 8))
          const items = await listMessages(args?.query, max)
          if (!items.length) return 'No messages matched.'
          return items
            .map((m) => `- ${m.date} — ${m.from || 'unknown'}: ${m.subject}`)
            .join('\n')
        },
      },
      {
        name: 'gmail_search',
        description:
          'Search Gmail with a filter — from:, subject, before:, is:unread — and ' +
          'return the matching subjects and senders. Use when the user asks to ' +
          'find a specific message.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'A Gmail search, e.g. "from:amazon is:unread".' } },
          required: ['query'],
        },
        handler: async (args) => {
          const q = String(args?.query ?? '').trim()
          const items = await listMessages(q, 12)
          if (!items.length) return `No messages matched "${q}".`
          return items
            .map((m) => `- ${m.date} — ${m.from || 'unknown'}: ${m.subject}`)
            .join('\n')
        },
      },
      {
        name: 'gmail_read',
        description:
          'Read one full message by its id (from gmail_list or gmail_search): ' +
          'sender, subject and the whole plain-text body. Use when the user asks ' +
          '"what does it say".',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The message id from gmail_list / gmail_search.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const id = String(args?.id ?? '').trim()
          if (!id) throw new Error('A message id is needed (from gmail_list).')
          const m = await googleFetch(`/gmail/v1/users/me/messages/${id}?format=full`)
          const h = headers(m)
          const body = bodyText(m)
          const MAX = 8000
          return [
            `From: ${h.from}`,
            `To: ${h.to}`,
            `Date: ${h.date}`,
            `Subject: ${h.subject}`,
            '',
            body.length > MAX ? `${body.slice(0, MAX)}…` : body,
          ].join('\n')
        },
      },
      {
        name: 'gmail_send',
        description:
          'Compose and send an email from the user\'s own Gmail account. Use ' +
          'when the user asks you to email someone. Say what you are sending ' +
          'before you send it.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'The subject line.' },
            body: { type: 'string', description: 'The message body.' },
          },
          required: ['to', 'subject', 'body'],
        },
        handler: async (args) => {
          const to = String(args?.to ?? '').trim()
          const subject = String(args?.subject ?? '').trim()
          const body = String(args?.body ?? '')
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`"${to}" is not an email address.`)
          if (!subject) throw new Error('An email needs a subject.')
          if (!body.trim()) throw new Error('An email needs a body.')
          const raw = [
            `To: ${to}`,
            'Content-Type: text/plain; charset=UTF-8',
            `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
            'MIME-Version: 1.0',
            '',
            body,
          ].join('\n')
          const sent = await googleFetch('/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: base64url(raw) }),
          })
          return `Sent to ${to} — "${subject}". (message ${sent?.id ?? 'sent'})`
        },
      },
      {
        name: 'gmail_connect',
        description:
          'Start the Google connection flow: opens the consent page in the user\'s ' +
          'browser. Give it a moment and it is done; say the result after calling.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const url = googleAuthUrl()
          if (!url) return 'Google is not configured — set JARVIS_GOOGLE_CLIENT_ID and JARVIS_GOOGLE_CLIENT_SECRET first.'
          return `Opening the Google consent page. The user should sign in, approve, and this connects them. URL: ${url}`
        },
      },
    ],
  }
}
