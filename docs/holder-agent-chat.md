# Open agent conversation

The website chat is open to everyone. It does not connect a wallet, request a
signature, or check token holdings. This supersedes the earlier >1 $AFTERHOUR
gate. Governance proposal eligibility and voting rules remain separate.

## Conversation flow

1. The browser automatically requests an anonymous session from
   `POST /api/chat/session` with an empty JSON object.
2. The backend creates a random, one-hour session in an HTTP-only, SameSite=Strict
   cookie (Secure and `__Host-` prefixed on HTTPS). A returning browser resumes
   its own conversation. No wallet identity is collected.
3. The browser sends only a message. The backend owns history, the independent
   Hermes conversation ID, the profile choice, instructions, and public evidence.
4. Every response passes through the existing tool-free Hermes proxy. The
   backend checks `/v1/models` and `/v1/toolsets` before every completion.
5. New chat removes the website's history and rotates the Hermes conversation
   ID. Hermes may retain its own records, as disclosed in the UI.

## Authority boundary

Chat sessions grant no governance, trading, signing, or proposal-submission
rights. The website uses the main read-only Hermes agent; no dedicated holder
profile or holder-specific key is required. Its API platform must have zero enabled
tools and no private operator context or global recall. Visitors are anonymous.

The internal strategy runner uses a separate service identity. There is no
operation that upgrades public chat to an execution session. Any future proposal
builder must separately authenticate and verify the user's proposal weight.

## Isolation and limits

- Transcripts are private to their random browser session, not public threads.
- Origin checks, bounded request size/history, one active turn per session, and
  a four-turn global concurrency cap remain enforced.
- Completion limits apply per session (8/minute) and IP (20/minute), so resetting
  cookies cannot bypass the IP limit. Session creation is also bounded.
- Old wallet session cookies do not expose old transcripts in public chat.
- A restart expires all local sessions. Use a shared atomic store before running
  multiple replicas. Forwarded IP headers are not trusted; proxy users share
  the IP allowance until trusted proxy handling is configured.
- Text replies use `textContent`, never model-supplied HTML.

The UI runs locally. Live replies still require the main agent's Hermes API URL and key. Without them, the composer is visible and a setup-pending notice is shown.
See `apps/web/README.md` for configuration.
