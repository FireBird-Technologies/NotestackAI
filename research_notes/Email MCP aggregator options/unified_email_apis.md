# Unified email APIs and MCP options

## Which products genuinely unify Gmail, Microsoft 365, and generic IMAP/SMTP?

### Takeaway
Nylas, Aurinko, Unipile, and EmailEngine all cover Gmail, Microsoft/Outlook, and generic IMAP-based accounts through one integration. Nylas and EmailEngine are especially relevant to an MCP client because they also publish native MCP surfaces; Aurinko and Unipile are managed unified REST APIs.

### Cited Findings
- Nylas Email API is one interface for reading, sending, searching, and managing mail across Gmail, Microsoft 365, Exchange, Yahoo, iCloud, and IMAP providers; its message model includes messages, threads, folders/labels, and attachments. — [Nylas Email API docs](https://developer.nylas.com/docs/v3/email/)
- Nylas sends on behalf of the authenticated user through that user's own provider; Google grants need `gmail.send`, while Microsoft grants need `Mail.ReadWrite` and `Mail.Send`. — [Nylas send-email docs](https://developer.nylas.com/docs/v3/email/send-email/)
- Aurinko's Email API normalizes Gmail, Office 365, Outlook.com, MS Exchange, Zoho Mail, iCloud, and IMAP, and includes reading/searching, flags, attachments, drafts/sending, and incremental synchronization. — [Aurinko Email API docs](https://docs.aurinko.io/unified-apis/email-api)
- Aurinko says it is mainly a pass-through platform: it proxies provider requests, may cache limited control data needed for deltas, and says processed email/event/contact/task contents are not stored on Aurinko servers. It manages provider token refresh and notification-subscription renewal. — [Aurinko Unified Mailbox API docs](https://docs.aurinko.io/)
- Unipile supports Gmail and Outlook with OAuth and other providers (including Yahoo, Zoho, AOL, and Apple) through IMAP/SMTP; its hosted auth flow can present Google, Microsoft Outlook, or IMAP as choices. — [Unipile account-linking docs](https://developer.unipile.com/v2.0/docs/link-email-accounts)
- Unipile provides a real-time new-email webhook for Google, Microsoft, and IMAP, and its pricing page lists email actions plus Gmail, Outlook, and IMAP coverage. — [Unipile webhook docs](https://developer.unipile.com/docs/new-emails-webhook); [Unipile pricing/features](https://www.unipile.com/pricing-api/)
- EmailEngine is a self-hosted gateway that reads, sends, and syncs Gmail, Microsoft 365, and generic IMAP mail through one REST API; it supports native Gmail API and Microsoft Graph as well as IMAP/SMTP. — [EmailEngine product page](https://emailengine.app/)
- EmailEngine's API manages accounts, reads/searches/changes messages, sends immediately or through an outbox, handles OAuth automatically, and pushes webhooks while maintaining mailbox sync. — [EmailEngine API overview](https://learn.emailengine.app/docs/api-reference)

### Inferences
- For the user's stated need—one provider that can operate many customers' existing mailboxes—these four are a better category fit than transactional senders such as SendGrid or SES, because they connect to end-user inboxes and act through those inboxes rather than only delivering mail from the application's own sending domain. This is an inference from their documented connected-account, sync, and send-on-behalf-of-user models. — [Nylas docs](https://developer.nylas.com/docs/v3/email/); [Aurinko docs](https://docs.aurinko.io/unified-apis/email-api); [Unipile docs](https://developer.unipile.com/v2.0/docs/link-email-accounts); [EmailEngine docs](https://learn.emailengine.app/docs/api-reference)
- Nylas has the broadest explicitly documented managed-provider list of the four; EmailEngine has the clearest self-hosted/any-IMAP positioning. — [Nylas docs](https://developer.nylas.com/docs/v3/email/); [EmailEngine product page](https://emailengine.app/)

### Gaps
- Provider-specific edge cases (shared mailboxes, delegated send-as, aliases, and on-premises Exchange versions) require a proof-of-concept against the user's exact target tenants; the high-level provider lists do not prove parity for every feature.

## Which are best for SaaS multi-tenant delegated access?

### Takeaway
Nylas is the strongest managed default for a multi-tenant SaaS that also needs MCP. Aurinko is the lowest-cost managed REST option in published entry pricing, Unipile is attractive when email must sit beside social/messaging channels, and EmailEngine is the strongest self-hosted option when the team accepts operating the sync infrastructure.

### Cited Findings
- Nylas models each authenticated user's mailbox as a `grant`; its docs state that users connect their own mailbox through OAuth and the same endpoints work across Gmail, Microsoft 365, iCloud, Yahoo, Exchange, and IMAP. — [Nylas documentation](https://developer.nylas.com/)
- Nylas's current plans include 5 connected email/calendar accounts free, Essentials at $15/month for 10 accounts plus $2.25 per extra account, and Pro at $49/month for 25 accounts plus $2.00 per extra account ($43/month and $1.75 per extra account annually); Enterprise is custom. — [Nylas pricing](https://www.nylas.com/pricing/)
- Aurinko offers user-delegated Account and User Session OAuth flows plus organization/admin Service Account flows; its unified flow uses provider OAuth for Google, Office 365, and Zoho and secure password-based auth for Exchange/IMAP. — [Aurinko OAuth flow](https://docs.aurinko.io/authentication/oauth-flow)
- Aurinko supports service-account access for G Suite, MS Exchange, and Office 365, including managed user accounts under an authorized service account. — [Aurinko service accounts](https://docs.aurinko.io/authentication/service-accounts)
- Aurinko's published Unified API price starts at $1/account/month for under 1 GB of data transfer, $1.50/account/month under 5 GB, and $2/account/month for unlimited transfer. — [Aurinko pricing](https://www.aurinko.io/pricing/)
- Aurinko requires the SaaS developer to supply its own Google, Microsoft, and Zoho OAuth client ID/secret for production. — [Aurinko Bubble integration guide](https://docs.aurinko.io/getting-started/bubble.io-plugin)
- Unipile offers both hosted white-label authentication and custom authentication for Google, Microsoft, and IMAP; the hosted flow is generated with one API call and walks each user through provider-specific authentication. — [Unipile connection methods](https://developer.unipile.com/docs/connect-accounts)
- Unipile charges by peak linked accounts: EUR 49/month for up to 10, then published per-account tiers starting at EUR 5/account/month, with API calls/messages not separately metered. It combines email/calendar with LinkedIn, WhatsApp, Instagram, and Telegram under the same account-based model. — [Unipile pricing](https://www.unipile.com/pricing-api/)
- Unipile states that its Gmail, Outlook, and IMAP email/calendar integrations use official APIs; on the same platform, its LinkedIn, WhatsApp, and Instagram integrations use reverse engineering. — [Unipile pricing FAQ](https://www.unipile.com/pricing-api/)
- EmailEngine lets a SaaS send users to its hosted auth form for Google/Microsoft or generic IMAP/SMTP and then maintains connections and refreshes tokens; it can also call the SaaS's own authentication server instead of storing credentials. — [EmailEngine quick start](https://learn.emailengine.app/docs/getting-started/quick-start); [EmailEngine authentication server docs](https://learn.emailengine.app/docs/accounts/authentication-server)
- EmailEngine is self-hosted and currently lists a flat $1,450 / EUR 1,200 annual license with unlimited mailboxes. It requires a server and Redis; the vendor says one instance can handle several thousand mailboxes, scales vertically, and must be sharded across separate instance/Redis pairs beyond that. — [EmailEngine product and operations page](https://emailengine.app/)

### Inferences
- Managed SaaS recommendation order: (1) Nylas when native MCP and broad provider coverage matter most, (2) Aurinko when price and CRM-style sync matter more than native MCP, (3) Unipile when email is one channel in a broader outreach product. — [Nylas MCP docs](https://developer.nylas.com/docs/dev-guide/mcp/); [Aurinko pricing](https://www.aurinko.io/pricing/); [Unipile pricing](https://www.unipile.com/pricing-api/)
- EmailEngine can become cheaper than per-account services at scale, but the license price is not the total cost: the team also owns deployment, Redis durability, monitoring, security patching, mailbox sharding, and incident response. This is an inference from its self-hosted architecture and documented Redis/scale requirements. — [EmailEngine product and operations page](https://emailengine.app/)

### Gaps
- Published prices do not capture enterprise support, SLA, regional data residency, provider verification assistance, or high-volume negotiated discounts; a vendor quote is needed before a final production decision.

## Are any officially exposed through MCP?

### Takeaway
Yes: Nylas has a hosted Streamable HTTP MCP server, and EmailEngine ships a self-hosted MCP endpoint currently labeled beta and disabled until enabled. No official MCP endpoint was found in the reviewed Aurinko or Unipile documentation, so those should be treated as REST APIs that need a small MCP adapter unless the vendors confirm otherwise.

### Cited Findings
- Nylas's hosted MCP endpoints are `https://mcp.us.nylas.com` and `https://mcp.eu.nylas.com`, use Bearer-token authentication, and work with MCP-compatible clients; the server exposes typed tools for email, calendar, contacts, and Notetaker. — [Nylas MCP docs](https://developer.nylas.com/docs/dev-guide/mcp/)
- Nylas MCP includes tools for listing/searching/getting messages and threads, folders, attachments, drafts, and sending; sending uses a two-step confirmation hash through `confirm_send_message`/`confirm_send_draft` before the send call. — [Nylas MCP tool list](https://developer.nylas.com/docs/dev-guide/mcp/)
- Nylas recommends narrowly scoped IAM API keys for production agents and supports resource- and permission-bound keys rather than exposing the organization management key. — [Nylas MCP security setup](https://developer.nylas.com/docs/dev-guide/mcp/)
- EmailEngine serves MCP at `POST /mcp`; its documented MCP surface covers curated account, folder, message, sending, and template tools and applies the same scoped-token permissions as its REST API. The endpoint is off by default. — [EmailEngine API reference](https://learn.emailengine.app/docs/api-reference)
- EmailEngine's official product page describes its MCP server as beta and states that an agent can hold an access token scoped to a single account and revoke it without receiving mailbox credentials. — [EmailEngine product page](https://emailengine.app/)

### Inferences
- For the user's existing outbound-MCP-connection feature, Nylas is the shortest path because it is already a hosted remote MCP endpoint. EmailEngine is the shortest self-hosted path but adds infrastructure and license operations. — [Nylas MCP docs](https://developer.nylas.com/docs/dev-guide/mcp/); [EmailEngine product page](https://emailengine.app/)
- Aurinko and Unipile can still be exposed as MCP with an application-owned adapter that maps a limited set of tools (for example `list_messages`, `get_message`, `create_draft`, `send_message`) to their REST APIs; this is an architectural inference from their REST endpoints, not a vendor-provided MCP feature. — [Aurinko Email API](https://docs.aurinko.io/unified-apis/email-api); [Unipile getting started](https://developer.unipile.com/docs/getting-started)

### Gaps
- Searches of the official Aurinko and Unipile docs did not surface an MCP product page. Because absence is difficult to prove from web search, confirm with sales/support if native MCP is a hard requirement.

## What operational and security caveats matter?

### Takeaway
The key risks are credential scope, accidental agent sends, OAuth-provider approval, cross-tenant isolation, provider rate limits, data residency, and—if self-hosting—durable sync infrastructure. The MCP server should never receive an unrestricted organization-wide credential when a per-user or per-grant key can be used.

### Cited Findings
- Nylas MCP uses the application's API key unless the developer provisions a narrower IAM key; Nylas explicitly recommends least-privilege keys bound to the specific resources and permissions needed by an agent. — [Nylas MCP docs](https://developer.nylas.com/docs/dev-guide/mcp/)
- Nylas's MCP send tools require a confirmation hash before a message or draft is sent, providing a built-in guard against unintended sends. — [Nylas MCP docs](https://developer.nylas.com/docs/dev-guide/mcp/)
- Nylas's hosted authentication supports provider detection and explicit Gmail, Microsoft, and generic IMAP choices; IMAP providers may involve host/port configuration. — [Nylas hosted-auth docs](https://developer.nylas.com/docs/v3/auth/customize-login-prompt/)
- Aurinko production integrations require the developer's own provider OAuth apps, and its unified auth also supports password-based IMAP/Exchange access; therefore the application must plan for Google verification/Microsoft app setup and higher sensitivity around any password-based connections. — [Aurinko OAuth docs](https://docs.aurinko.io/authentication/oauth-flow); [Aurinko production OAuth note](https://docs.aurinko.io/getting-started/bubble.io-plugin)
- EmailEngine notes that external Google OAuth apps can require Google verification and that Microsoft 365 has retired basic authentication for Exchange Online, requiring an Entra app and OAuth permissions. — [EmailEngine quick start](https://learn.emailengine.app/docs/getting-started/quick-start)
- EmailEngine stores credentials/tokens unless configured to fetch them from the SaaS's authentication server; it says stored credentials and secrets are encrypted with AES-256-GCM. — [EmailEngine product page](https://emailengine.app/); [EmailEngine authentication server docs](https://learn.emailengine.app/docs/accounts/authentication-server)
- EmailEngine requires durable Redis configured with `noeviction`, and low latency between the application and Redis; multiple EmailEngine copies cannot share one Redis database for horizontal scaling. — [EmailEngine operations FAQ](https://emailengine.app/)
- Unipile itself does not impose request/message limits, but provider limits and policies still apply. — [Unipile pricing FAQ](https://www.unipile.com/pricing-api/)
- Apideck should not be treated as a comparable unified mailbox API here: its current Gmail connector is explicitly `auth-only` and uses a provider-specific Proxy API, while its Transactional Email connector catalog lists Gmail, Mailgun, and SendGrid as auth-only. — [Apideck Gmail overview](https://developers.apideck.com/apis/transactional-email/gmail/overview); [Apideck Transactional Email catalog](https://developers.apideck.com/apis/transactional-email)

### Inferences
- The correct multi-tenant design is to associate each local user/tenant with a vendor grant/account ID, issue or proxy the narrowest possible MCP credential for that scope, and enforce an application-side recipient allowlist, send-rate cap, audit log, and human confirmation for consequential sends. The need for scoped credentials is directly supported; the exact additional controls are engineering recommendations. — [Nylas MCP security](https://developer.nylas.com/docs/dev-guide/mcp/); [EmailEngine scoped-token model](https://learn.emailengine.app/docs/api-reference)
- If the application merely needs to send transactional mail from domains it owns, these mailbox-sync products are probably excessive; a transactional email provider is operationally simpler. If the product needs to read/reply/sync and send as each customer's existing Gmail/Outlook/custom-domain inbox, these unified mailbox products are the correct category. This is an inference from the documented mailbox sync and delegated-user models. — [Nylas Email API](https://developer.nylas.com/docs/v3/email/); [Aurinko Email API](https://docs.aurinko.io/unified-apis/email-api)

### Gaps
- The user's exact requirement is still ambiguous between (a) connecting customers' existing inboxes and sending as them, and (b) sending bulk/transactional mail from domains the application controls. That choice changes the recommended vendor category.
- A production security review should verify each vendor's current SOC reports, DPA/subprocessors, retention/deletion behavior, data-residency region, incident history, and Gmail restricted-scope verification posture; those details were outside this focused feature comparison.
