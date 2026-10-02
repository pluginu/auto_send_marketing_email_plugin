# SIN Email Marketing Management

Current build: **v0.1.1**

A Chrome Manifest V3 extension that generates personalized sales-email drafts with OpenAI and prepares them in the Private Email web interface.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open and sign in to `https://privateemail.com/`.
5. Click the extension icon to open the side panel.
6. In **Settings**, add an OpenAI API key and sender details.
7. Import a CSV in **Contacts**, configure the offer, then generate and review drafts.

## CSV columns

An actual email address is required for a row to be imported. The importer accepts either the recommended fields below or Profile Audit exports automatically.

Recommended headers: `email`, `name`, `company`, `role`, `persona`, `interests`, `problem`, `notes`, `profile_url`, `site`.

Profile Audit aliases include `email_addresses`, `profile_name`, `profile_url`, `phone_numbers`, and `social_platforms`. Unknown populated columns are retained as additional personalization context. Rows without an address and duplicate addresses are skipped and reported after import. Quoted commas are supported.

## Safety and privacy

- Automatic sending is off by default; the normal flow prepares one draft for review.
- The API key, contacts, and drafts are stored in Chrome local extension storage. They are not sent anywhere except contact context sent to OpenAI to create a draft.
- OpenAI requests use `store: false`.
- Use this only for permission-based, legally compliant outreach. Add the sender identity, postal address, and opt-out wording required in your jurisdiction.
- Private Email is a third-party web interface. If its DOM changes, update the layered selectors in `content.js`.

## Troubleshooting

If the panel says **Open Private Email**, open or refresh the Private Email tab after installing the extension. If composing fails, keep the inbox visible, dismiss cookie banners, and retry. Chrome only injects content scripts into already-open tabs after a refresh.

The extension verifies that Private Email retained the generated body before automatic sending. If verification fails, it stops without clicking Send. Open **Settings → Diagnostic log** to view, export, or clear the latest 1,000 diagnostic events. Exports use newline-delimited JSON (`.ndjson`) and exclude the OpenAI API key.
