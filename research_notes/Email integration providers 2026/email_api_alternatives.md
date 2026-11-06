# Email-specific integration alternatives

## Which providers support Gmail and Outlook with hosted OAuth and a unified API?

### Takeaway
Nylas, Aurinko, Unified.to, and Unipile all have credible Gmail/Outlook coverage with a unified mail model and hosted account connection. Nylas is the deepest email-specialist product; Aurinko is the clearest low-cost specialist; Unified.to is broad and privacy-forward but has a high production floor; Unipile is useful when NoteStack also wants social messaging. Merge's normalized Email category is still beta/coming soon, while Apideck's Gmail connector is auth-only rather than a unified mailbox API.

### Cited Findings
- Nylas exposes a single Email API for reading, sending, searching, drafts, threads, folders, attachments, and contacts across Gmail, Microsoft 365, Exchange, Yahoo, iCloud, and IMAP. Its Messages API uses one interface across Gmail, Microsoft 365, and IMAP, including provider-native search and webhooks. — [Nylas Email API](https://developer.nylas.com/docs/v3/email/); [Nylas Messages API](https://developer.nylas.com/docs/v3/email/messages/)
- Nylas Hosted OAuth covers Google and Microsoft and manages token refresh; it also supports a provider-selection page. Production normally requires a Google or Azure provider app and a Nylas connector. — [Nylas authentication](https://developer.nylas.com/docs/v3/auth/); [Hosted login customization](https://developer.nylas.com/docs/v3/auth/customize-login-prompt/)
- Nylas supports draft-first review as a first-class flow: create a draft, let a person review it in their Drafts folder, update it, and then send it. This is particularly suitable for an AI assistant where writes should remain human-approved. — [Nylas send and draft flow](https://developer.nylas.com/docs/v3/email/send-email/)
- Aurinko supports Gmail, Office 365, Outlook.com, Exchange, Zoho, iCloud, and IMAP through one REST API, including inbox search, attachments, incremental synchronization, drafts, sending, and tracking. It handles provider token refresh and renews provider notification subscriptions. — [Aurinko platform](https://docs.aurinko.io/); [Aurinko Email API](https://docs.aurinko.io/unified-apis/email-api)
- Aurinko describes itself as mainly pass-through: it may cache identifiers and relationship metadata for sync/deltas, but says it does not store the content of processed emails, events, contacts, or tasks. — [Aurinko platform](https://docs.aurinko.io/)
- Unified.to's Messaging API lists both Gmail and Microsoft Outlook, and its Gmail model supports create, list, get, remove, and update message operations. Its quick start returns a connection ID after embedded authorization. — [Unified Messaging integrations](https://docs.unified.to/messaging/integrations); [Gmail integration details](https://docs.unified.to/integrations/googlemail); [Unified quick start](https://docs.unified.to/quick-start)
- Unified.to says it processes requests in memory and discards source records after the request, and provides native or polling-based virtual webhooks. — [Unified API architecture](https://docs.unified.to/concepts/what-is-a-unified-api); [Unified pricing and webhook behavior](https://unified.to/pricing)
- Unipile supports hosted white-label authentication for Gmail, Outlook, and IMAP and exposes unified email operations including list, send, reply, delete, move, folders, new-email webhooks, and tracking. Unipile says its email/calendar connectors use official APIs even though some of its social connectors use reverse engineering. — [Unipile email hosted auth](https://developer.unipile.com/v2.0/docs/link-email-accounts); [Unipile pricing/capabilities](https://www.unipile.com/pricing-api/)
- Merge advertises Gmail under a unified Email category, but the integration page marks Outlook Email as beta and the Gmail data models as "coming soon." Its Launch plan is also $650/month for up to 10 production linked accounts. — [Merge Gmail integration](https://www.merge.dev/integrations/gmail); [Merge Unified pricing](https://www.merge.dev/pricing/unified)
- Apideck labels its Gmail connector `auth-only`, with no normalized Unified API and no webhooks, so it can manage credentials for passthrough but does not remove Gmail/Graph API differences. — [Apideck Gmail connector](https://developers.apideck.com/apis/transactional-email/gmail/overview); [Apideck API categories](https://developers.apideck.com/apis)

### Inferences
- For NoteStack's immediate mail-specific feature, Nylas and Aurinko are more direct architectural substitutes for two provider-specific Pipedream tool catalogs than Merge or Apideck because both normalize mailbox resources and lifecycle events, not just authentication.
- A draft-first API is safer than exposing unrestricted send tools directly to an LLM: NoteStack can default to creating drafts and require user confirmation before the final send.

### Gaps
- Public documentation does not provide independently measured webhook delivery latency or failure rates for these vendors; a production bake-off must measure duplicate delivery, gaps, retry behavior, and reconnect recovery.
- Aurinko's public site did not expose a readily verifiable SOC 2 or ISO certificate in the researched pages; this should be confirmed through its sales/security review before handling mailbox data.

## Pricing, security, sync quality, limits, and lock-in

### Takeaway
Aurinko is the least expensive published specialist at $1-$2 per connected account, Nylas has a stronger product surface at roughly $1.75-$2.25 per additional account depending on plan, and Unipile starts at €49/$55 monthly. Unified.to and Merge have much higher production minimums. Unified and Aurinko explicitly minimize content storage, while every unified provider still introduces schema, identifier, OAuth, and operational lock-in.

### Cited Findings
- Aurinko publishes usage tiers of $1/account/month under 1 GB transfer, $1.50 under 5 GB, and $2 for unlimited transfers; its higher-level BrightSync email product starts at $3/user/month. — [Aurinko pricing](https://www.aurinko.io/pricing/)
- Nylas includes five connected accounts on the free plan; published overage prices are $2.25, $2.00, or $1.75 per additional email account depending on plan. Nylas Enterprise offers contractual uptime SLA, BAA, and dedicated support. — [Nylas pricing](https://www.nylas.com/pricing/)
- Nylas sends through the underlying mailbox provider, and provider rate limits still apply. A throttled send returns `429` and the application owns the retry; Nylas recommends idempotency keys to prevent duplicate sends. — [Nylas sending behavior](https://developer.nylas.com/docs/v3/email/send-email/)
- Aurinko's sync/delta model abstracts provider differences, provisions provider subscriptions, and renews or recreates them when lost. Native Gmail push requires configuring Google Pub/Sub; Aurinko webhooks use a shared-secret signature. — [Aurinko platform](https://docs.aurinko.io/); [Aurinko Gmail Pub/Sub setup](https://docs.aurinko.io/unified-apis/webhooks-api/configuring-pub-sub-for-gmail-api-webhooks); [Aurinko webhooks](https://docs.aurinko.io/unified-apis/webhooks-api)
- Unified.to's production Grow plan starts at $750/month for 750,000 monthly API calls, with unlimited customers/connections; Pro starts at $1,500 and Scale at $3,000. Successful calls and delivered native/virtual webhook events consume the request allowance. — [Unified pricing](https://unified.to/pricing)
- Unified.to states SOC 2 Type II, GDPR, CCPA/CPRA, PIPEDA, and HIPAA compliance, no end-customer payload storage, TLS 1.2+, AES-256 for minimal operational metadata, regional deployments, and optional customer-owned secrets storage on higher plans. These are vendor claims; audit reports are available through its Trust Center. — [Unified security](https://unified.to/security)
- Unipile charges €49/$55 per month for up to 10 accounts, then €5/$5.50 per account for 11-50, declining with volume; API usage is unlimited apart from provider limits. — [Unipile pricing](https://www.unipile.com/pricing-api/)
- Gmail push watches must be renewed at least every seven days, with Google recommending daily renewal. Microsoft Outlook subscriptions last under seven days without resource data and under one day with rich resource data. — [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push); [Microsoft Graph subscription lifetime](https://learn.microsoft.com/en-us/graph/change-notifications-overview)
- Microsoft Graph's Outlook service limits each app/mailbox combination to 10,000 requests per 10 minutes, four concurrent requests, and 150 MB uploaded in five minutes. Microsoft recommends honoring `Retry-After` and using change notifications rather than continuous polling. — [Microsoft Graph service limits](https://learn.microsoft.com/en-us/graph/throttling-limits); [Microsoft throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)
- Unified API lock-in is concrete: Gmail and Graph have different native identifiers and semantics, while a provider-specific `grant_id`/connection ID and normalized message schema become application persistence keys. Nylas itself notes Gmail, Microsoft, and IMAP message ID formats differ. — [Nylas Messages API](https://developer.nylas.com/docs/v3/email/messages/)

### Inferences
- At early-stage volume, Aurinko's per-account price is materially friendlier than Unified.to's $750 minimum, Merge's $650 minimum, or Unipile's $55 minimum. Nylas costs more per account than Aurinko but includes a more polished auth/IAM and email feature surface.
- The biggest lock-in is not REST syntax; it is storing vendor connection/grant IDs, normalized message IDs, webhook cursors, and vendor-specific auth state. NoteStack should maintain its own `(user, provider, provider_account_id)` identity layer and keep a thin adapter so Pipedream, Nylas, or direct provider clients remain replaceable.
- Aggregators remove subscription-renewal and token-refresh plumbing, but do not remove provider throttles, OAuth consent policy, or the need for application-level idempotency and audit logs.

### Gaps
- Nylas's pricing page exposes per-account overage figures but its crawled table did not reliably preserve every plan's base monthly price; verify the final quote before committing.
- Vendor-published compliance claims are not substitutes for reviewing the actual SOC 2 report, DPA, subprocessor list, breach terms, deletion SLA, and whether mailbox bodies or tool results enter vendor logs.

## Google and Microsoft verification implications

### Takeaway
An aggregator normally does not make Google's restricted-scope obligations disappear when NoteStack uses its own branded OAuth project. Reading Gmail messages requires a restricted scope, which triggers Google verification and, when data is transmitted through servers, an annual security assessment. Sending-only is substantially easier. Nylas uniquely documents a paid shared Google app that can transfer this burden to Nylas, at the cost of the consent screen showing "Nylas."

### Cited Findings
- Google classifies `gmail.send` as sensitive, but `gmail.readonly`, `gmail.compose`, `gmail.modify`, `gmail.metadata`, and full-mail access as restricted. Restricted scopes require OAuth verification; transmitting or storing restricted-scope data on a server requires a security assessment. — [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- Google says restricted-scope apps that access data through a third-party server must undergo an approved CASA security assessment and revalidation at least every 12 months. Development/testing projects, personal use, internal organization-only apps, and admin-allowlisted deployments have documented exceptions. — [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- Nylas confirms that hosted token management does not, by itself, eliminate Google's review: normal production setup uses the customer's Google Cloud project, and restricted Gmail scopes still require verification plus CASA. — [Nylas Google verification guide](https://developer.nylas.com/docs/provider-guides/google/google-verification-security-assessment-guide/); [Nylas authentication](https://developer.nylas.com/docs/v3/auth/)
- Nylas's paid Google Shared App has already passed verification and CASA and lets customers use restricted Gmail scopes without running their own assessment; users see “Nylas” on the consent screen, custom hosted-auth hostname is unavailable, and the feature requires annual Pro plus an Accelerator add-on or an Enterprise add-on. — [Nylas Shared Google App](https://developer.nylas.com/docs/provider-guides/google/shared-gcp-app/); [Nylas verification guide](https://developer.nylas.com/docs/provider-guides/google/google-verification-security-assessment-guide/)
- Aurinko says production applications need their own Google and Microsoft OAuth client IDs/secrets. Unified.to likewise says its credentials may be used for testing for some integrations, but production should switch to the customer's own OAuth credentials for branding. — [Aurinko Bubble/production auth](https://docs.aurinko.io/getting-started/bubble.io-plugin); [Unified pricing FAQ](https://unified.to/pricing)
- Microsoft supports delegated `Mail.Send` for personal and organizational accounts. Outlook webhook subscriptions require a read scope such as `Mail.Read`, and administrators can restrict user consent in managed tenants. — [Microsoft sendMail permissions](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0); [Outlook change notifications](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview)

### Inferences
- NoteStack should split capability consent: request send-only only when the user asks to send, and request restricted Gmail read access only for users enabling inbox research. This reduces the default blast radius and avoids CASA for send-only users.
- If NoteStack cannot absorb Google verification/CASA before launch, the realistic shortcuts are Pipedream's managed OAuth or Nylas's Shared Google App. Aurinko, Unified.to, and direct APIs do not remove the production verification burden when using NoteStack branding.
- Outlook's provider gate is operationally simpler than Gmail's restricted-scope security assessment, but enterprise tenant admin-consent policies can still block individual users; the UI needs an administrator-required state rather than treating every OAuth failure as bad credentials.

### Gaps
- Public pricing for the Nylas Accelerator/Google Shared App add-on was not available in the researched documentation.
- Pipedream's exact Google OAuth verification/branding arrangement for Connect should be confirmed contractually; its managed flow appears to use Pipedream-owned auth, but the researched sources for this subtask did not establish whether every Gmail scope and production scenario is covered.

## When direct APIs are better and the best early-stage choice

### Takeaway
For NoteStack now, Nylas is the best email-specialist alternative if a polished, deep mail product and a path around Google CASA matter; Aurinko is the best value if NoteStack will own Google/Microsoft OAuth verification. Direct Gmail API + Microsoft Graph becomes better when email is strategic enough to justify two durable adapters, provider-specific features matter, and per-account aggregator fees dominate engineering cost.

### Cited Findings
- Direct Gmail server-side OAuth returns access and refresh tokens that the application must store securely and refresh; Google recommends OAuth libraries because authorization implementation has security implications. — [Gmail server-side authorization](https://developers.google.com/workspace/gmail/api/auth/web-server); [Google OAuth overview](https://developers.google.com/identity/protocols/oauth2/)
- A direct implementation must maintain Gmail Pub/Sub watches at least weekly and Graph subscriptions under their maximum lifetime, recover missed/removed Graph subscriptions, and handle each provider's throttling and native schemas. — [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push); [Graph subscription lifetime](https://learn.microsoft.com/en-us/graph/change-notifications-overview); [Graph lifecycle notifications](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)
- Direct Gmail/Graph APIs carry no per-connected-account middleware charge, while published aggregators charge by account or impose a monthly platform minimum. — [Aurinko pricing](https://www.aurinko.io/pricing/); [Nylas pricing](https://www.nylas.com/pricing/); [Unified pricing](https://unified.to/pricing); [Unipile pricing](https://www.unipile.com/pricing-api/)
- Direct integration does not avoid Google's restricted-scope review: `gmail.readonly` and `gmail.modify` remain restricted and require the same verification/security-assessment analysis. — [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes); [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

### Inferences
- Recommended shortlist for NoteStack:
  1. **Nylas** when email is a first-class feature: strongest unified mailbox surface, hosted provider picker, draft-review workflow, webhooks, and a paid verified Google app that can bypass NoteStack's own CASA burden.
  2. **Aurinko** when cost and pass-through handling dominate: $1-$2/account, strong delta/webhook design, and no stored message content, but NoteStack owns production OAuth clients and Google verification.
  3. **Direct Gmail + Graph** when NoteStack expects large account volume or needs exact native behavior and can fund ongoing provider maintenance and compliance.
- Unified.to is credible but its $750/month production floor is disproportionate for only Gmail/Outlook. Unipile is reasonable at $55/month if NoteStack soon wants LinkedIn/WhatsApp alongside email; otherwise its broader channel scope is not an advantage. Merge Unified Email is too immature to recommend while Gmail models are coming soon and Outlook is beta; Apideck auth-only does not solve mailbox normalization.
- A low-risk migration path is to keep the current Pipedream implementation for launch, add a provider-neutral internal mail capability layer (`search`, `get_thread`, `create_draft`, `send_draft`, `reply`), and run a small Nylas-versus-Aurinko bake-off before moving credentials or user connections.

### Gaps
- No public benchmark establishes whether Nylas, Aurinko, Unified.to, or direct APIs are more reliable for NoteStack's actual message-search and tool-call patterns; test with Gmail personal, Google Workspace, Outlook.com, Microsoft 365, shared mailboxes, revoked scopes, and high-volume threads.
- Final selection requires confidential commercial details: Shared Google App price, uptime SLA, support response, data-deletion SLA, breach liability, subprocessor list, and whether AI/LLM processing is contractually permitted under each provider's Google user-data terms.
