// ---------------------------------------------------------------------------
// Atlas Universal — Connector Registry
//
// The single source of truth for every external system Atlas can connect to.
// Each entry describes a REAL platform: its actual authentication mechanism,
// required environment variables, OAuth scopes and capabilities. Nothing here
// is simulated.
//
// `implementationStatus` is the honest contract:
//   - "implemented" → a real client exists in this codebase (OAuth flow, sync
//     or test path wired to the provider's actual API).
//   - "planned"     → the provider's API/auth is documented and the registry
//     entry is complete, but the client has not been built yet. The UI shows
//     these as roadmap items — never as "Connected".
//
// Every connector must implement the same underlying contract
// (see connections.ts listConnectorCatalog + connectionsSync.ts testConnection).
// ---------------------------------------------------------------------------

export type ConnectorAuthType = "oauth2" | "api_key" | "none";

export type ConnectorCapability =
  | "read"
  | "write"
  | "webhook"
  | "polling"
  | "sync_documents"
  | "search";

export type ImplementationStatus = "implemented" | "planned";

export interface ConnectorDefinition {
  /** Stable provider key. Persisted on the connections.provider field. */
  id: string;
  name: string;
  category:
    | "document_storage"
    | "email"
    | "communication"
    | "crm"
    | "accounting"
    | "project_management"
    | "payments"
    | "development"
    | "productivity"
    | "uploads"
    // Restoration-industry families (MASTER #1 integration foundation).
    | "estimating"
    | "field_evidence"
    | "property_intelligence"
    | "storage"
    | "other";
  authType: ConnectorAuthType;
  implementationStatus: ImplementationStatus;
  capabilities: ConnectorCapability[];
  /** Server-side env vars required before a real connection can be made. */
  requiredEnvVars: string[];
  /** OAuth scopes requested during authorization (server-side only). */
  oauthScopes?: string[];
  description: string;
  /** Exact, honest setup instructions surfaced in the UI. */
  setupInstructions: string;
  docsUrl?: string;
}

export const CONNECTOR_REGISTRY: ConnectorDefinition[] = [
  {
    id: "manual_upload",
    name: "Manual file uploads",
    category: "uploads",
    authType: "none",
    implementationStatus: "implemented",
    capabilities: ["read", "sync_documents", "search"],
    requiredEnvVars: [],
    description:
      "Files uploaded directly to Atlas. Parsed, embedded and searched with the same pipeline every other source uses.",
    setupInstructions:
      "No configuration needed. Upload files from the Knowledge page — supported formats are PDF, DOCX, XLSX, XLS, CSV, MD and TXT.",
  },
  {
    id: "google_drive",
    name: "Google Drive",
    category: "document_storage",
    authType: "oauth2",
    // HONESTY CORRECTION (MASTER #1 audit): this entry previously claimed
    // "implemented", but no Drive client exists in this repository — there is no
    // `connections-sync-google-drive` function, and
    // `connections-run-due-syncs/source/index.ts` states the same thing in its
    // own honesty note. A connector counts as implemented only when real client
    // code (OAuth flow + sync or test path) is present. It is not, so this is
    // now correctly reported as roadmap.
    implementationStatus: "planned",
    capabilities: ["read", "polling", "sync_documents", "search"],
    requiredEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    oauthScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    description:
      "Syncs PDFs, Word, Excel, CSV, Google Docs and Google Sheets into the knowledge base with change detection and de-duplication.",
    setupInstructions:
      "Create an OAuth 2.0 Client ID in the Google Cloud Console, add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to your project Keys, and register https://<your-project>.supabase.co/functions/v1/connections-sync-google-drive/google/oauth/callback as an authorized redirect URI.",
    docsUrl: "https://developers.google.com/drive/api/guides/about-auth",
  },
  {
    id: "google_gmail",
    name: "Gmail",
    category: "email",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "polling", "search"],
    requiredEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    oauthScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    description:
      "Reads email threads for the people and accounts Atlas tracks — proposals, correspondence and updates.",
    setupInstructions:
      "Same Google OAuth client as Drive. Enable the Gmail API in Google Cloud and add the gmail.readonly scope. Client roadmap: authorization URL, callback, then thread ingestion.",
    docsUrl: "https://developers.google.com/gmail/api/auth",
  },
  {
    id: "microsoft_365",
    name: "Microsoft 365",
    category: "document_storage",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "polling", "sync_documents", "search"],
    requiredEnvVars: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT_ID"],
    oauthScopes: ["Files.ReadWrite.All", "offline_access"],
    description:
      "OneDrive & SharePoint documents through the Microsoft Graph API — same ingestion pipeline as Drive.",
    setupInstructions:
      "Register an app in the Microsoft Entra admin center, set MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT_ID in your project Keys, and authorize at https://login.microsoftonline.com/common/oauth2/v2.0/authorize.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/auth-v2-user",
  },
  {
    id: "slack",
    name: "Slack",
    category: "communication",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "polling", "webhook", "search"],
    requiredEnvVars: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    oauthScopes: ["channels:history", "channels:read", "files:read", "users:read"],
    description:
      "Channels, messages and files become conversational evidence — Atlas can answer 'what did the team say about X?'",
    setupInstructions:
      "Create a Slack app, add the listed bot scopes, set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET in your project Keys, and authorize at https://slack.com/oauth/v2/authorize.",
    docsUrl: "https://api.slack.com/docs/oauth",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "crm",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "write", "webhook", "polling"],
    requiredEnvVars: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
    oauthScopes: [
      "crm.objects.contacts.read",
      "crm.objects.companies.read",
      "crm.objects.deals.read",
    ],
    description:
      "Contacts, companies and deals map to Atlas customers and projects — the CRM becomes part of the knowledge layer.",
    setupInstructions:
      "Create a private app or public app in HubSpot, set HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET in your project Keys, and authorize at https://app.hubspot.com/oauth/authorize.",
    docsUrl: "https://developers.hubspot.com/docs/api/oauth/overview",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    category: "accounting",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "webhook", "polling"],
    requiredEnvVars: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
    oauthScopes: ["com.intuit.quickbooks.accounting"],
    description:
      "Invoices, payments and AR aging become financial evidence for Atlas recommendations.",
    setupInstructions:
      "Create an Intuit app in the Intuit Developer portal, set QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET in your project Keys, and authorize at https://appcenter.intuit.com/connect/oauth2.",
    docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    authType: "api_key",
    implementationStatus: "planned",
    capabilities: ["read", "webhook", "polling"],
    requiredEnvVars: ["STRIPE_SECRET_KEY"],
    description:
      "Payments, invoices and subscription events — revenue signals for the decision engine.",
    setupInstructions:
      "Set STRIPE_SECRET_KEY (server-side only, never a publishable key) in your project Keys. Client roadmap: customers/invoices read + webhook ingestion.",
    docsUrl: "https://docs.stripe.com/api",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    category: "document_storage",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "polling", "sync_documents", "search"],
    requiredEnvVars: ["DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET"],
    oauthScopes: ["files.content.read", "files.metadata.read"],
    description: "Dropbox files through the Dropbox API — same ingestion pipeline as Drive.",
    setupInstructions:
      "Create an app in the Dropbox App Console, set DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET in your project Keys, and authorize at https://www.dropbox.com/oauth2/authorize.",
    docsUrl: "https://developers.dropbox.com/oauth-guide",
  },
  {
    id: "notion",
    name: "Notion",
    category: "productivity",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "write", "webhook", "polling"],
    requiredEnvVars: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
    oauthScopes: ["Read workspace content"],
    description: "Pages and databases become structured knowledge — SOPs, wikis and project trackers.",
    setupInstructions:
      "Create an integration in the Notion integration dashboard, set NOTION_CLIENT_ID / NOTION_CLIENT_SECRET in your project Keys, and authorize at https://api.notion.com/v1/oauth/authorize.",
    docsUrl: "https://developers.notion.com/docs/authorization",
  },
  {
    id: "github",
    name: "GitHub",
    category: "development",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "webhook", "polling", "search"],
    requiredEnvVars: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    oauthScopes: ["repo"],
    description: "Repositories, issues and pull requests — engineering operations as evidence.",
    setupInstructions:
      "Register an OAuth app in GitHub Developer settings, set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in your project Keys, and authorize at https://github.com/login/oauth/authorize.",
    docsUrl: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
  },

  // -----------------------------------------------------------------------
  // Restoration-industry business systems (MASTER #1 registry entries).
  //
  // Every entry below is `planned`: the provider identity, authentication type
  // and capabilities are recorded so the foundation can address them, but NO
  // client code exists yet, so the UI must never show them as connected. Where
  // the provider gates API access behind a partner agreement, that requirement
  // is stated instead of guessed — `setupInstructions` is the honest blocker,
  // not a fake implementation.
  // -----------------------------------------------------------------------
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    category: "communication",
    authType: "api_key",
    implementationStatus: "planned",
    capabilities: ["read", "write", "webhook", "search"],
    requiredEnvVars: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"],
    description:
      "Customer conversations in WhatsApp — inbound messages and media become claim evidence, outbound replies stay governed by Atlas approvals.",
    setupInstructions:
      "Create a Meta app with the WhatsApp Business (Cloud API) product, then set WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN in your project Keys and register the webhook URL. Client roadmap: inbound message ingestion, media download into evidence, approved outbound replies.",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
  },
  {
    id: "jobnimbus",
    name: "JobNimbus",
    category: "crm",
    authType: "api_key",
    implementationStatus: "planned",
    capabilities: ["read", "write", "polling", "webhook"],
    requiredEnvVars: ["JOBNIMBUS_API_KEY"],
    description:
      "Jobs, contacts, tasks and documents from JobNimbus map onto Atlas jobs, customers and work items — the CRM stays the system of record for sales, Atlas for intelligence.",
    setupInstructions:
      "Generate an API key in JobNimbus (Settings → API) and set JOBNIMBUS_API_KEY in your project Keys. Client roadmap: job/contact sync, document retrieval, task creation. Webhook verification requires the account's webhook signing configuration.",
    docsUrl: "https://documenter.getpostman.com/view/3919598/S11PpG4x",
  },
  {
    id: "companycam",
    name: "CompanyCam",
    category: "field_evidence",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "webhook", "polling"],
    requiredEnvVars: ["COMPANYCAM_CLIENT_ID", "COMPANYCAM_CLIENT_SECRET"],
    description:
      "Project photos and annotations flow into Atlas evidence, tied to the claim and property they document.",
    setupInstructions:
      "Request a CompanyCam API application from CompanyCam developer support, set COMPANYCAM_CLIENT_ID / COMPANYCAM_CLIENT_SECRET in your project Keys, and register the Atlas OAuth callback. Client roadmap: project + photo sync with webhook freshness.",
    docsUrl: "https://docs.companycam.com/",
  },
  {
    id: "xactimate",
    name: "Xactimate / XactAnalysis",
    category: "estimating",
    authType: "api_key",
    implementationStatus: "planned",
    capabilities: ["read", "polling"],
    requiredEnvVars: ["XACTIMATE_API_KEY", "XACTIMATE_CLIENT_ID"],
    description:
      "Estimates, line items and XactAnalysis assignment/claim data — the estimate becomes structured evidence for supplement and completeness analysis.",
    setupInstructions:
      "UNRESOLVED PROVIDER REQUIREMENT: Xactware API access is partner-gated and is not self-service. Atlas cannot connect until a XactAnalysis/Xactimate API agreement and credentials are issued by Xactware. Record the granted credential names here once issued; do not guess endpoints.",
    docsUrl: "https://www.xactware.com/en-us/products/",
  },
  {
    id: "eagleview",
    name: "EagleView",
    category: "property_intelligence",
    authType: "api_key",
    implementationStatus: "planned",
    capabilities: ["read", "polling"],
    requiredEnvVars: ["EAGLEVIEW_CLIENT_ID", "EAGLEVIEW_CLIENT_SECRET"],
    description:
      "Roof measurements and aerial reports become property evidence — measurements Atlas can cite instead of re-deriving.",
    setupInstructions:
      "UNRESOLVED PROVIDER REQUIREMENT: EagleView API access requires a partner/enterprise agreement (API credentials are issued by EagleView). Record the issued credential names here; do not guess endpoints.",
    docsUrl: "https://www.eagleview.com/",
  },
  {
    id: "hover",
    name: "HOVER",
    category: "property_intelligence",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "polling"],
    requiredEnvVars: ["HOVER_CLIENT_ID", "HOVER_CLIENT_SECRET"],
    description:
      "3D property models, measurements and photo sets — high-fidelity property evidence for scope validation.",
    setupInstructions:
      "UNRESOLVED PROVIDER REQUIREMENT: HOVER API access is issued through a HOVER partnership/API agreement. Record the granted credential names here once issued; do not guess endpoints.",
    docsUrl: "https://hover.to/",
  },
  {
    id: "acculynx",
    name: "AccuLynx",
    category: "crm",
    authType: "oauth2",
    implementationStatus: "planned",
    capabilities: ["read", "write", "webhook", "polling"],
    requiredEnvVars: ["ACCULYNX_CLIENT_ID", "ACCULYNX_CLIENT_SECRET"],
    description:
      "Jobs, contacts, documents and financials from AccuLynx map onto Atlas jobs and customers for cross-system intelligence.",
    setupInstructions:
      "UNRESOLVED PROVIDER REQUIREMENT: AccuLynx API access requires an application approved by AccuLynx. Record the granted client credentials here once issued; do not guess endpoints.",
    docsUrl: "https://api.acculynx.com/",
  },
];

/** Fast lookup by provider key. */
export const CONNECTOR_BY_ID: Record<string, ConnectorDefinition> =
  Object.fromEntries(CONNECTOR_REGISTRY.map((c) => [c.id, c]));
