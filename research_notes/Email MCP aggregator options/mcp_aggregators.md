# Multi-app MCP integration platforms for email

## Which vendors offer a single MCP endpoint or SDK with multiple email providers?

### Takeaway
The strongest verified product-integration candidates are **Composio, Pipedream Connect, Nango, and Arcade**. **Zapier MCP** has the widest catalog, but its documented MCP product is primarily tied to a Zapier user's/account's own app connections; Zapier points customer-facing embedded products toward its separate Developer Platform/Workflow API.

### Cited Findings
- **Composio:** Composio Connect is a hosted MCP server at `https://connect.composio.dev/mcp` with 1,000+ apps behind one connection; it exposes seven meta-tools for discovery, auth, and execution rather than loading every tool definition. For an application, Composio recommends creating a per-user session MCP endpoint instead of using the shared Connect URL. — [Composio Connect docs](https://docs.composio.dev/docs/composio-connect); [Sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp)
- Composio has verified Gmail and Outlook toolkits. Its current Gmail catalog lists 63 tools including send, draft, reply, search/fetch, labels, attachments, settings, and triggers; Outlook supports OAuth2 and service-to-service OAuth and has hundreds of mail/calendar tools including send, reply, query/search, drafts, attachments, and shared-mailbox operations. — [Composio Gmail toolkit](https://docs.composio.dev/toolkits/gmail); [Composio Outlook toolkit](https://docs.composio.dev/toolkits/outlook); [Outlook MCP catalog](https://composio.dev/toolkits/outlook)
- **Pipedream Connect:** Pipedream documents one hosted MCP server at `https://remote.mcp.pipedream.net` for 3,000+ APIs and 10,000+ tools, with managed auth and end-user connection UI/Connect Link. — [Pipedream MCP for Developers](https://mcp.pipedream.com/developers)
- Pipedream's v3 MCP interface can combine several app slugs in one session. The official IMAP + Microsoft Outlook example uses `x-pd-app-slug: "imap,microsoft_outlook"` and `x-pd-external-user-id` to return both toolsets in one MCP session; Outlook has 26 actions, while that IMAP connector has only one action plus a new-email trigger. — [Pipedream IMAP + Outlook](https://pipedream.com/apps/imap/integrations/microsoft-outlook)
- Pipedream's app catalog verifies Gmail (24 actions, five triggers, API proxy), Microsoft Outlook, IMAP, and transactional-mail connectors such as Twilio SendGrid. — [Pipedream app catalog](https://pipedream.com/apps); [Outlook MCP server](https://mcp.pipedream.com/app/microsoft_outlook); [IMAP app](https://pipedream.com/apps/imap)
- **Nango:** Nango positions itself as an open-source integration platform for 1,000+ APIs, with managed auth, tools/actions/syncs, MCP support, and cloud, BYOC, or self-hosted deployment. Its catalog explicitly includes Gmail and Outlook. — [Nango GitHub repository](https://nango.dev/repo); [Nango integration catalog](https://nango.dev/api-integrations/)
- Nango's hosted MCP invocation is connection-specific: its Gmail example points the client to `https://api.nango.dev/mcp` and identifies the selected integration and account with `provider-config-key` and `connection-id` headers. Nango exposes enabled actions as MCP tools and injects that connection's credentials. — [Nango Gmail MCP tutorial](https://nango.dev/blog/how-to-build-a-gmail-api-integration-with-nango-and-claude)
- **Arcade:** Arcade MCP Gateways federate tools from multiple Arcade-hosted toolkits, custom servers, and third-party remote MCP servers behind one Streamable HTTP URL. Its catalog includes Gmail and Microsoft Outlook Mail. — [Arcade MCP Gateways](https://docs.arcade.dev/en/operate/governance/mcp-gateways); [Connect to MCP clients](https://docs.arcade.dev/en/get-started/mcp-clients)
- Arcade's Gmail toolkit currently documents 31 tools for reading, searching, drafting, sending, replying, forwarding, attachments, labels, and mailbox management; its Microsoft Outlook Mail toolkit documents 30 tools and requires a Microsoft work or school account. — [Arcade Gmail](https://docs.arcade.dev/en/resources/integrations/productivity/gmail); [Arcade Outlook Mail](https://docs.arcade.dev/en/resources/integrations/productivity/microsoft-outlook-mail)
- **Zapier MCP:** Zapier says one MCP server can expose actions from 9,000+ apps / 40,000+ actions, and the same server can work across several apps. It supports Gmail and Microsoft Outlook actions such as sending mail, creating drafts, replying, forwarding, moving messages, and searches. — [What is Zapier MCP?](https://help.zapier.com/hc/en-us/articles/48308034391821-What-is-Zapier-MCP); [Zapier Outlook integration](https://zapier.com/apps/Microsoft-Outlook/integrations)
- Zapier's own product description separates its offerings: Zapier MCP connects MCP clients to the apps in a Zapier account, while the Developer Platform / Workflow API is the stated product for embedding 9,000+ integrations into a company's customer-facing product. — [What is Zapier?](https://help.zapier.com/hc/en-us/articles/37518970271245-What-is-Zapier)

### Inferences
- **Best default shortlist for this repository:** Composio and Pipedream are the clearest fits if `OutboundMcpConnections` needs a hosted, multi-app MCP connection for many application users. Both explicitly document per-user application sessions/identifiers and managed downstream auth.
- Nango is the strongest option when self-hosting, exportable credentials, custom integration code, or avoiding lock-in matters more than having the broadest polished catalog immediately.
- Arcade is especially attractive when the requirement extends beyond email into governance/federation of multiple MCP servers, but it may be more platform than needed for a simple Gmail/Outlook connector.
- Zapier MCP is excellent for an internal/personal assistant connected to an existing Zapier account; it should not be assumed to be a drop-in multi-tenant embedded auth layer without validating Zapier's Developer Platform contract and architecture.

### Gaps
- No official source found that Composio, Nango, Arcade, or Zapier exposes a provider-neutral **SMTP send-as-any-domain** mailbox interface. They expose provider/toolkit-specific actions; a generic SMTP or unified-mail abstraction would need separate verification or custom tooling.
- Pipedream's current IMAP connector is not a full generic email solution: the cited catalog shows mailbox selection and a new-email trigger, not a generic SMTP send action.

## Do they support Gmail, Microsoft Outlook, and generic SMTP?

### Takeaway
All five shortlisted platforms verify Gmail and Outlook/Microsoft 365 support. None should be described as a single normalized SMTP/IMAP mailbox API: the tools remain provider-specific, and “generic email” coverage is partial.

### Cited Findings
- Composio's Gmail toolkit includes `GMAIL_SEND_EMAIL`, drafts, replies, fetch/search, labels, attachments, settings, and triggers; its Outlook toolkit includes `OUTLOOK_SEND_EMAIL` and extensive Outlook/Microsoft Graph operations. — [Composio Gmail toolkit](https://docs.composio.dev/toolkits/gmail); [Composio Outlook toolkit](https://docs.composio.dev/toolkits/outlook)
- Pipedream supports Gmail and Microsoft Outlook Email as OAuth apps and exposes both through hosted MCP tools; its IMAP app says “Connect to any IMAP email provider” but currently lists only one action (“List Mailbox Options”) and one new-email trigger. — [Pipedream Gmail MCP](https://mcp.pipedream.com/app/gmail); [Pipedream Outlook MCP](https://mcp.pipedream.com/app/microsoft_outlook); [Pipedream IMAP app](https://pipedream.com/apps/imap)
- Pipedream also lists outbound delivery services such as Twilio SendGrid in its app catalog, which is useful for transactional email but is not the same as reading/sending from a user's normal mailbox. — [Pipedream app catalog](https://pipedream.com/apps)
- Nango's public integration catalog lists both Gmail and Outlook; Nango's Gmail MCP tutorial verifies a typed `send-email` action through its hosted MCP endpoint. — [Nango integrations](https://nango.dev/api-integrations/); [Nango Gmail MCP tutorial](https://nango.dev/blog/how-to-build-a-gmail-api-integration-with-nango-and-claude)
- Arcade's Gmail toolkit uses Google OAuth and covers the full mailbox lifecycle; Arcade's Outlook Mail toolkit uses Microsoft Graph, supports read/compose/send/search/organize, and includes shared/delegated mailboxes, but excludes personal Microsoft accounts such as `@outlook.com` and `@hotmail.com`. — [Arcade Gmail](https://docs.arcade.dev/en/resources/integrations/productivity/gmail); [Arcade Outlook Mail](https://docs.arcade.dev/en/resources/integrations/productivity/microsoft-outlook-mail)
- Zapier has both Gmail and Microsoft Outlook integrations exposed to MCP. Its Microsoft Outlook connector requires Microsoft 365 Business/Enterprise plus Exchange Online; Zapier separately documents that its Office 365 connector does not support Outlook.com/Home 365 accounts. — [Zapier Outlook prerequisites](https://help.zapier.com/hc/en-us/articles/18836255979277-How-to-get-started-with-Microsoft-Outlook-on-Zapier); [Gmail + Office 365 integration](https://zapier.com/apps/gmail/integrations/office-365)

### Inferences
- If “other email domains” means a company address hosted on Google Workspace or Microsoft 365, Gmail/Outlook OAuth already covers custom domains; a generic SMTP layer is unnecessary for those users.
- If it means arbitrary mailbox hosts, none of these should be sold internally as universal mail coverage. Pipedream's IMAP connector currently appears too thin for full read/write mailbox use, and SMTP sending would likely require a dedicated provider connector (SendGrid/Mailgun/Postmark/etc.) or a custom MCP server.

### Gaps
- The reviewed official pages do not establish full generic SMTP send plus IMAP read support under one normalized schema.
- Nango's catalog verifies Gmail and Outlook presence, but the specific prebuilt Outlook action list was not readily exposed by the indexed official docs reviewed here.

## Is delegated per-user OAuth supported?

### Takeaway
Composio, Pipedream Connect, Nango, and Arcade all explicitly support acting on behalf of distinct end users. Zapier supports app connections and OAuth, but its MCP server is documented around the Zapier account/client rather than an application-controlled external-user ID.

### Cited Findings
- Composio sessions are created with a `user_id` and scope that user's connected accounts, tool access, and authentication; a session can be exposed as a hosted MCP endpoint. — [How Composio sessions work](https://docs.composio.dev/docs/how-composio-works); [Sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp)
- Composio has managed OAuth plus custom auth configs. Gmail can use Composio-managed OAuth or the developer's own OAuth app; Outlook supports browser OAuth, tenant admin consent, shared mailboxes, and explicit account selection for multiple connected accounts. — [Composio Gmail](https://docs.composio.dev/kb/guide/toolkits-gmail); [Composio Outlook](https://docs.composio.dev/kb/guide/toolkits-outlook)
- Pipedream Connect resolves accounts by the application's stable `x-pd-external-user-id`; users can connect through an embedded frontend SDK or Connect Link, and Pipedream stores/manages OAuth credentials. — [Pipedream MCP for Developers](https://mcp.pipedream.com/developers); [Pipedream IMAP + Outlook](https://pipedream.com/apps/imap/integrations/microsoft-outlook)
- Nango says authorization occurs on behalf of end users; connections can be user-level or organization-level, multiple connections for the same API/user are supported, token refresh is managed, and credentials can be exported. — [Nango auth overview](https://docs.nango.dev/guides)
- Nango Connect sessions take an `end_user.id` and can limit `allowed_integrations`, providing a short-lived token for that user to create connections. — [Nango Create Connect Session](https://docs.nango.dev/reference/api/connect/sessions/create)
- Arcade tool-level authorization runs an OAuth flow the first time a user calls a protected tool, stores that user's authorization separately, and reuses it until revoked. — [Arcade user authorization](https://docs.arcade.dev/en/build/create-tools/tool-basics/create-tool-auth); [Arcade remote MCP auth](https://docs.arcade.dev/en/operate/governance/remote-mcp-servers)
- Zapier app connections can use OAuth2 and are reusable within the Zapier account; Zapier MCP connects a client to “your Zapier account,” and each named MCP client gets its own server. — [Zapier app connections](https://help.zapier.com/hc/en-us/articles/36818633398157-App-connections-on-Zapier); [What is Zapier MCP?](https://help.zapier.com/hc/en-us/articles/48308034391821-What-is-Zapier-MCP)

### Inferences
- For a SaaS backend that already has its own user IDs, Composio, Pipedream, and Nango have the cleanest documented identity mapping.
- Use the developer's own Google/Microsoft OAuth app for production branding, scope control, quota isolation, and provider verification; vendor-managed OAuth is best treated as a fast development path unless the vendor contract explicitly covers the intended production scale.

### Gaps
- Zapier's public MCP docs reviewed here do not document an `external_user_id`-style API for minting a per-customer MCP session. The separate Powered by Zapier / Workflow API should be evaluated if Zapier is preferred for an embedded SaaS use case.

## What are the main engineering and pricing caveats?

### Takeaway
Provider consent and scope review—not MCP transport—is likely the hardest production issue. Cost models differ sharply: Composio charges mostly per tool call, Pipedream per external user plus usage credits, Nango per connection/compute/egress, Arcade per tool call, and Zapier per task.

### Cited Findings
- **Composio pricing:** Free includes 100,000 tool calls/month, 50,000 triggers, and unlimited own-app connected accounts; managed OAuth apps have a smaller included pool and paid per-call/per-connection rules. Pro is $29/month with usage credit; enterprise adds controls such as KMS/SSO/SCIM. — [Composio pricing](https://landing.composio.dev/pricing)
- Composio warns that Gmail scopes such as `gmail.send` may require Google verification; Outlook may require Microsoft tenant admin consent; and auth links expire in roughly ten minutes. — [Composio Gmail guide](https://docs.composio.dev/kb/guide/toolkits-gmail); [Composio Outlook guide](https://docs.composio.dev/kb/guide/toolkits-outlook)
- Composio's shared Connect MCP uses meta-tools/Tool Router rather than direct app tool names, while application session endpoints can be scoped to selected toolkits. Toolkit tools are versioned and older pinned versions eventually deprecate/retire. — [Composio Connect](https://docs.composio.dev/docs/composio-connect); [Toolkit versioning](https://docs.composio.dev/docs/tools-direct/toolkit-versioning)
- **Pipedream pricing:** development is free; production starts at $99/month billed annually or $150 monthly, including 100 external users and 10,000 usage credits, then $2 per additional user and $0.012 per additional credit. A user with five connected apps counts once. — [Pipedream pricing](https://pipedream.com/pricing)
- **Nango pricing:** Free allows 10 connections, 10 compute hours, and 10 GB transfer monthly. PAYG is $50/month including credits, then $0.29 per connection-month, $0.72/compute-hour, and $0.50/GB egress. Enterprise adds self-hosting/BYOC. — [Nango pricing](https://nango.dev/pricing)
- Nango is open source under the Elastic License; its official repository says free self-hosting has a limited feature set, while cloud/BYOC plans add more features. — [Nango GitHub repository](https://nango.dev/repo)
- **Arcade pricing:** Free includes 2,000 tool calls/month; Team is $25/month plus $0.01/tool call; enterprise offers cloud, VPC, or air-gapped deployment and governance features. — [Arcade pricing](https://www.arcade.dev/pricing/)
- Arcade's default Google OAuth provider has fixed scopes, shared rate limits, and Arcade branding; its docs strongly recommend the developer's own Google OAuth provider for production. Arcade also says multiple accounts for the same provider require contacting the company. — [Arcade Google auth](https://docs.arcade.dev/en/references/auth-providers/google); [Arcade FAQ](https://docs.arcade.dev/en/resources/faq)
- **Zapier pricing/usage:** each successful MCP tool call currently consumes two Zapier tasks, including tests; repeated batch actions count separately. Zapier MCP uses Streamable HTTP only, requires one server per named client, and server sharing requires Team or Enterprise. — [Zapier MCP usage](https://help.zapier.com/hc/en-us/articles/45645738385805-How-Zapier-MCP-usage-works); [What is Zapier MCP?](https://help.zapier.com/hc/en-us/articles/48308034391821-What-is-Zapier-MCP)
- Outlook enterprise restrictions recur across vendors: Microsoft tenant admins may need to approve the OAuth app, and Arcade/Zapier's cited Outlook integrations require work/school or Business/Enterprise accounts rather than personal Outlook.com accounts. — [Composio Outlook guide](https://docs.composio.dev/kb/guide/toolkits-outlook); [Arcade Outlook](https://docs.arcade.dev/en/resources/integrations/productivity/microsoft-outlook-mail); [Zapier Outlook prerequisites](https://help.zapier.com/hc/en-us/articles/18836255979277-How-to-get-started-with-Microsoft-Outlook-on-Zapier)

### Inferences
- **Recommended proof of concept:** test Composio first for the fastest multi-tenant session-MCP path and lowest published entry price; test Pipedream second if broader app/trigger coverage and direct multi-app tool listing are more important.
- **Recommended self-host/custom path:** Nango, especially if the product needs credential export, custom integration functions, or on-prem/BYOC later.
- **Recommended governance-heavy path:** Arcade when tool curation, approvals, redaction, remote-MCP federation, or enterprise deployment are first-class requirements.
- For send/delete operations, the application should expose draft-first tools or require explicit approval. This is an architectural safety recommendation, not a vendor guarantee.
- Before choosing, run the same acceptance test against each provider: connect a custom-domain Google Workspace mailbox and a Microsoft 365 tenant; list/search/read; create draft; send; reply in-thread; attach a file; revoke/reconnect; test tenant-admin consent; and verify that one application user cannot select another user's connection.

### Gaps
- Published pricing can change and does not show every enterprise/security add-on; production volume should be confirmed with each vendor.
- No benchmark found in official sources for real-world latency, tool-call reliability, or schema quality across the five vendors.
- No official source reviewed guarantees Google restricted-scope verification on behalf of the developer's own production OAuth app; this remains the developer's/provider's approval process.
