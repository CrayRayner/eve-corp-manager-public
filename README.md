# EVE Corp Manager

Hi! Mostly Vibe Coded this App with Claude Code and Cursor. Was intended for the management of my own corp but I thought might as well build it in a way that others could benefit too. So here it is.

A private, local-only corporation management dashboard for EVE Online. All data stays on your machine — nothing is sent anywhere except to ESI (esi.evetech.net), your SMTP server if you configure email alerts, and optionally a Discord webhook for structure alerts.

---

## For End Users — Installing the App

1. Download the latest `EVE-Corp-Manager-Setup-x.x.x.exe` from the [Releases](../../releases) page
2. Run the installer, choose your install path, let it finish
3. Launch **EVE Corp Manager** from your desktop or Start Menu
4. Log in with your Director or CEO character via EVE SSO
5. A **First Steps tutorial** pops up on the first launch — follow it to get up and running quickly
6. Data syncs automatically — no terminal, no browser, no setup

> **First launch:** The app creates its config and database automatically in `%AppData%\eve-corp-manager\`. Nothing is written to the install folder. Consider alt→main mapping in settings as your first step to get properly aggregated data (on main chars, not on every alt).

> **Antivirus / Windows Defender may flag the installer or EXE** — Some antivirus software will report the installer or the app as a potential threat (e.g. “Unknown publisher”, “Heuristic” or “Generic” detection). **The program is safe.** It is open-source and does not contain malware. Common reasons for false positives: (1) the app is **not code-signed** (no paid certificate from a CA), so Windows and AV vendors treat it as “unknown”; (2) **Electron** apps bundle Node.js and native code, which can trigger heuristic scans; (3) new or rarely-downloaded executables often lack a “reputation” score. You can add an exclusion for the install folder or the downloaded installer, or choose “Run anyway” / “More info → Run anyway” when Windows warns. Builds are produced locally via `npm run dist`; the source is on GitHub for review.

---

## Features

| Tab | What it shows |
|-----|---------------|
| **Overview** | KPI summary — wallet, fuel status, recent kills, top taxpayers; dashboard load errors show a retry banner |
| **Structures** | Fuel days remaining, gas stock, alerts for low fuel/gas; fuel overrides and manual gas data (Metenox); manual location names for stock stations. Automatic fuel/mo is from online service modules; if it shows ~2× in-game, set **Display → Fuel “month” hours** to 360 (15-day period). |
| **Metenox** | Moon drill profitability vs live Jita prices, manual material entry. Materials dropdown is grouped by R tier (R4→R64) and sorted alphabetically within each tier. Gas modal: enter **quantity in Metenox after refilling** (total in structure), not the amount added. |
| **Wallet & Tax** | Monthly corp flow chart (income / expenses / net per month, last 12 months, CSV export of all history); corp wallet journal (search + Enter), taxpayer leaderboard (alt-aggregated), CSV export |
| **Corp Kills** | Top 10 Killers + Top 10 by Losses (rolling 30-day or monthly); doughnut charts per pilot with favourite ship icons (from EVE image server); kill and loss history charts; recent kills and losses tables with zKill links |
| **Contracts** | Corp contracts with scope filters (For Corp / By Corp / Alliance / All) and status filters; location column; NEW badge on tab for unseen contracts; email + Discord notification on new contracts assigned to corp |
| **Member Health** | Tax, kills, activity, login weights for activity tracking; Fleet Points addable; responsive KPI grid |
| **Settings** | Sync status, backup & restore, email & Discord notifications, **Visible Tabs** (hide unused tabs), **Display** (color-blind mode, date format, fuel month hours), corp rates, fuel hangar selector, alt→main mappings |

**UX & accessibility**
- **First Steps tutorial** — shown automatically on first login; re-launchable any time from Settings → Visible Tabs → “? Show Tutorial”.
- **Visible Tabs** — Settings → Visible Tabs: hide any tab your corp doesn’t use. Overview and Settings are always shown. Changes apply instantly without a restart.
- **Color-blind friendly mode** — Settings → Display. Uses blue/orange/magenta palette for charts and indicators; applies to all built-in charts.
- **Date format** — Settings → Display: choose **dd.mm.yyyy (EU)** or **mm.dd.yyyy (US)**; applies to all date displays.
- **Keyboard** — Arrow Left/Right switch tabs (when not in an input; hidden tabs are skipped); Escape closes modals.
- **Toasts** — Success/error feedback via non-blocking toasts (bottom-right).
- **API errors** — Server error messages are shown in the UI; dashboard and exports show retry or clear messages.
- **Responsive** — Member Health KPIs reflow to 2 columns (≤680px) and 1 column (≤480px).

**Notifications**
- **Email** — Optional SMTP config for fuel/gas structure alerts; check runs after every sync (deduplication prevents repeat alerts within 24 h).
- **Discord webhook** — Optional webhook URL; fuel/gas alerts and new contract notifications are posted to your Discord channel. Test with **Send Test to Discord** in Settings.
- **Contract alerts** — New contracts assigned to your corp trigger a notification within ~15 minutes (contracts sync every 15 minutes).

---

## What syncs automatically

| Data | Frequency |
|------|-----------|
| Structures & fuel | Every hour |
| Corp wallet | Every hour |
| Corp assets (gas/fuel stock) | Every hour |
| Member tracking | Every 30 minutes |
| Corp contracts | **Every 15 minutes** |
| Corp kills | Every 6 hours |
| Corp losses | Every 6 hours (alongside kills) |
| Jita market prices | Every 5 minutes |
| Fuel/gas alert check | After every sync |
| Monthly snapshot | 1st of each month |

**Sync Now** is also available from the Settings tab.

---

## Closing the App

- **Log Off Only** — closes the window, keeps the server running in the background (syncs continue). Re-open via the tray icon.
- **Shut Down** — stops everything completely. Access via the Logout button in the top-right.
- **X button** — shuts down completely (same as Shut Down).

---

## EVE SSO Scopes Required

When registering your application at https://developers.eveonline.com/applications, choose **Native Application** (no client secret). Add these scopes:

- `esi-wallet.read_corporation_wallets.v1`
- `esi-corporations.read_structures.v1`
- `esi-corporations.read_corporation_membership.v1`
- `esi-corporations.track_members.v1`
- `esi-industry.read_corporation_mining.v1`
- `esi-assets.read_corporation_assets.v1`
- `esi-universe.read_structures.v1`
- `esi-contracts.read_corporation_contracts.v1`

Callback URL: `http://localhost:3000/auth/callback`

---

## CSV exports

You can export data as CSV for use in spreadsheets or external reporting:

- **Wallet & Tax tab** — **Export tax CSV**: tax summary by period. **Export CSV** next to Wallet Journal: journal entries for the selected period and optional ref-type filter, up to 10,000 rows. **Export CSV** next to the Monthly Corp Flow chart: all available monthly income/expenses/net history.

Files download with sensible names (e.g. `wallet-journal-2026-03.csv`, `tax-summary-2026-03.csv`, `corp-monthly-flow.csv`).

---

## Email & Discord Notifications (optional)

Structure alerts (low fuel blocks or low magmatic gas) and new contract notifications can be sent by **email** and/or **Discord**. Configure in **Settings → Email & Discord Notifications**:
- Enter SMTP server, port, username, password
- For Gmail: use an [App Password](https://support.google.com/accounts/answer/185833), not your regular password
- Set **Fuel Block Alert Threshold** (days) and **Magmatic Gas Alert Threshold** (days)
- Enter **Recipients** (comma- or semicolon-separated email addresses)
- Optionally set **From Address** (e.g. `EVE Corp Dashboard <no-reply@example.com>`)
- **Discord Webhook URL** (optional): create a webhook in Discord (Channel → Edit → Integrations → Webhooks)
- Click **Send Test Email** or **Send Test to Discord** to verify

**How it works**
- The alert check runs **after every sync** (not just once a day).
- For each corp structure it compares **fuel days remaining** and **magmatic gas days** to your thresholds. All qualifying structures are sent in one digest with structure name, system, type, days left, and expiry date.
- The same structure and alert type is **not re-sent within 24 hours**.
- New contracts assigned to corp trigger an alert within ~15 minutes of the next sync.
- You can **turn notifications off** without clearing SMTP or Discord settings.
- Recent sent alerts appear under **Recent Alerts Sent** (scrollable, last 10 entries).

---

## Security & data protection

- **OAuth tokens** — Access and refresh tokens are encrypted at rest via Electron safeStorage (Windows DPAPI) in the packaged app. Backups contain encrypted values — treat backup files as sensitive.
- **SMTP password** — Encrypted at rest; only a “password set” flag is sent to the UI.
- **Session** — Session cookie uses `httpOnly`, `sameSite: ‘lax’` (required for OAuth redirects from EVE SSO). Login uses EVE SSO with PKCE (no client secret) and OAuth state for CSRF protection.
- **Backup & restore** — Restore only accepts valid SQLite databases (magic-bytes check).
- **API** — All routes require an authenticated session; SQL uses parameterized queries throughout.

---

## Alt → Main Mapping

Aggregate kills, losses, and tax by main character:
- **Settings tab → Import CSV** — one `AltName,MainName` pair per line
- Or run `python scripts\import_alts.py` to import from Corp Management.xlsx

---

## Data Location

All data is stored in `%AppData%\eve-corp-manager\corp.db` (SQLite). OAuth tokens and SMTP password are stored encrypted. Uninstalling the app does **not** delete this folder — your data is preserved across updates.

---

## For Developers — Running from Source

### Prerequisites
- Node.js v22+ — https://nodejs.org
- Git

### Setup
```bash
git clone <repo-url>
cd eve-app
npm install
```

Create a `.env` file:
```
EVE_CLIENT_ID=your_client_id
EVE_CALLBACK_URL=http://localhost:3000/auth/callback
SESSION_SECRET=any_long_random_string
```

> Use **Native Application** in the EVE dev portal — no client secret. Keep `SESSION_SECRET` long and random (or let the packaged app generate it on first launch).

### Run in Electron (dev mode)
```bash
npm run electron
```
This opens the full app window. Right-click → Inspect for DevTools.

### Build Windows installer
```bash
npm run dist
```
Output: `dist/EVE-Corp-Manager-Setup-x.x.x.exe`

**Changing the app icon before building**

- **EXE and installer icon (Windows)**
  Put your icon file in the `build/` folder and name it **`app.ico`** (not `icon.ico`). The build reads `build/app.ico` (see `package.json` → `build.win.icon`). So: copy your .ico into `build/`, rename it to **app.ico**, then run `npm run dist`.
  To get a placeholder first, run `npm run make-icon` — that creates `build/icon-placeholder.ico`. Use a multi-size .ico (e.g. 16×16, 32×32, 48×48, 256×256) for best results.

- **Tray icon (system tray)**
  The tray uses the image from `electron/icon.js`, which currently generates a solid teal square. To use your own image: add a PNG (e.g. `electron/icon.png`) and change `electron/icon.js` to load it:
  `module.exports = require(‘electron’).nativeImage.createFromPath(require(‘path’).join(__dirname, ‘icon.png’));`

### Security check (dependencies)
```bash
npm run security-check
```
Runs `npm audit`. Use `npm audit fix` (or `npm audit fix --force` after checking breaking changes) before releases.

> **Note:** After `npm run dist`, `better-sqlite3` is compiled for Electron’s Node.js. Use `npm run electron` for dev — do not use `npm start` (system Node.js version mismatch).

---

## Quick reference — maintainers

| I want to… | Do this |
|------------|--------|
| **Run the app (dev)** | `npm run electron` |
| **Build installer** | `npm run dist` |
| **Check dependencies** | `npm audit`; then `npm audit fix` |
| **Re-show tutorial** | Settings → Visible Tabs → “? Show Tutorial” |
| **Hide unused tabs** | Settings → Visible Tabs → uncheck tabs |
| **Backup data** | Settings → Backup & Restore → Download. Store securely — file contains tokens. |
| **Restore data** | Settings → Backup & Restore → choose file → Upload. Restart to apply. |
