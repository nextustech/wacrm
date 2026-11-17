import { APP_RELEASE_CHANNEL, APP_VERSION } from "@/lib/app-version";
import type { PdfBlock } from "@/lib/docs/simple-pdf";

export interface ReleaseNotes {
  version: string;
  date: string;
  headline: string;
  sections: { title: string; items: string[] }[];
}

/** Release notes for the current version, mirroring docs/changelog.html. */
export const CURRENT_RELEASE_NOTES: ReleaseNotes = {
  version: APP_VERSION,
  date: "2026-11-13",
  headline:
    "Version 7.3.4 adds LINE, WeChat and Viber as inbox channels, makes the AI Reply Assistant faster and attachment-aware, rebuilds Theme Manager to support multiple independently editable themes, and fixes a tenant-admin crash plus an app-wide email/domain search bug.",
  sections: [
    {
      title: "Inbox and messaging",
      items: [
        "Connect LINE Messaging API, WeChat Official Account and Viber Bot as new inbox channels, alongside the existing ones.",
        "Coexistence echo messages no longer count against the billing quota.",
        "Fix an inbound email bug where a text/plain stub was shown instead of falling back to the HTML alternative, and a separate bug that could drop a verification code from an inbound email.",
        "Add a scroll-to-message jump when tapping a reply preview, and fix an attachment losing its filename.",
        "Conversation list: show a relative-time info popover, pack the name row left with a dashed account/time footer, fix a name-truncation bug, and show which connected account a thread arrived on.",
        "Email bubbles render only the real message content, not the full quoted thread.",
      ],
    },
    {
      title: "AI Reply Assistant",
      items: [
        "Generate from the full conversation instead of only the latest message, and stop ignoring the chosen reply direction mid-generation.",
        "Noticeably faster replies, with the real cause (not just symptoms) addressed.",
        "Read image, PDF, DOCX, XLSX, CSV and TXT attachments as part of the reply context.",
        "Clearer Generate reply card with a close button and a synced dropdown, an expanded and searchable Translate language list, and fixed popover flicker/position glitches.",
      ],
    },
    {
      title: "Theme Manager",
      items: [
        "Rebuilt end to end: create and independently edit multiple themes, switch between them from a left sidebar, and always see unambiguously which theme is live versus which one you're editing.",
        "Save and Activate are now separate, explicit actions — editing a theme never changes what's live until you choose to activate it.",
        "Replace native browser confirmation popups with proper dialogs, and require confirmation before deleting a theme (previously instant and irreversible).",
        "Workspace typography (heading font and font-weight) now applies consistently app-wide.",
      ],
    },
    {
      title: "Admin and platform",
      items: [
        "Fix a crash opening Super Admin → Tenants → Add Tenant.",
        'Fix owner search reporting "No matching user found" for a real, existing user — the root cause was a stale, empty profile email column.',
        'Fix an app-wide search bug where any email or domain containing a "." never matched.',
        "Deploy the WhatsApp QR worker to Fly.io; QR-linked WhatsApp numbers now appear in the inbox account selector.",
        "Demo mode: a new Customization Canvas lets evaluators live-preview brand colors, fonts and theme presets instantly via local storage, with zero database writes.",
      ],
    },
    {
      title: "Upgrade notes",
      items: [
        "Apply all pending migrations with: npx supabase db push --include-all --yes.",
        "Set WACRM_VERSION=7.3.4 in .env if you pin the version for Docker builds.",
        "Read docs/releases/v7.3.4.md for detailed changes and verification notes.",
      ],
    },
  ],
};

export function releaseNotesToPdfBlocks(notes: ReleaseNotes, brandName: string): PdfBlock[] {
  const blocks: PdfBlock[] = [
    { type: "title", text: `${brandName} v${notes.version}` },
    { type: "subtitle", text: `Release notes \u00b7 ${APP_RELEASE_CHANNEL} \u00b7 ${notes.date}` },
    { type: "rule" },
    { type: "text", text: notes.headline },
  ];
  for (const section of notes.sections) {
    blocks.push({ type: "heading", text: section.title });
    for (const item of section.items) blocks.push({ type: "bullet", text: item });
  }
  blocks.push({ type: "space", size: 14 });
  blocks.push({ type: "rule" });
  blocks.push({
    type: "subtitle",
    text: `Full history: /docs/changelog.html \u00b7 (c) 2026 ${brandName}`,
  });
  return blocks;
}
