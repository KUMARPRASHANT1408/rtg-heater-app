# RTG Heater Management

Heater (component by component) and consumables issue, return and tracking for the RTG Store.

- **Front end**: `docs/`, plain HTML/CSS/JS served by GitHub Pages. No build step.
- **Backend**: Google Apps Script web app over one Google Sheet (`backend/`, or the single pasted file `dist/Code.gs`).
- **Mail**: the script never mails people. It mails your one company inbox and a Power Automate flow sends the real mails from company mail.

**Built so far**
- Stage 1: login, roles, user management, heater search with availability, component inventory.
- Stage 2: heater request (RTGH0001...) → admin approve/reject with mail → ticket (HEATER_0001...) → component-wise issue at the store
  (parts suggested from one set) → return and inspection per component (OK / Damaged / Missing / still on site) → raise issue with mail to FM
  asking for an explanation → close. Returned parts go to "maintenance due" and can't be issued again until maintenance is recorded.
  Daily overdue mails until every part is back. Daily .xlsx export to your company inbox (password columns removed).

- Stage 3: site transfers. FM asks to move a heater that is on site straight to another conveyor (RTGT0001...) with a reason,
  employee ID and new return date. Approval goes RTG team → RTG HOD → RTG Chief **and** FM Chief (both, either order), with a mail to
  each approver as their turn comes. FM and RTG both see a tracker of where it is pending. Rejection at any stage tells FM to return the
  heater. On full approval the ticket, its parts and the return date move to the new conveyor and the extra joint is counted.
  Give approvers the roles `HOD`, `RTG Chief` and `FM Chief` (with their company email) on the Users page.

- Stage 4: consumables. Stock by batch with expiry (first-expiring stock is issued first, expired stock never), low-stock and
  expiry warnings, this month's and average monthly use, department-wise consumption by month, SAP stock vs physical stock.
  Admins update stock by hand (receipt, issue, correction) or upload a CSV file (every row is checked first; nothing is saved
  unless all rows are right). Requests: RTGC0001 → admin approve/reject with mail → ticket CONS_0001 → issue deducts stock.

- Stage 5: heater maintenance. The vendor team (users with Team = Vendor) logs each day which parts they maintained, with the
  filled checklist as a photo or PDF (saved in a Google Drive folder). RTG checks the log and the checklist; on "Verified" the parts
  become ready to issue again, on "Not OK" the vendor gets a mail and logs it again.

See `SHEET_GUIDE.md` for what every tab and column means. Run `clearTestData` once before going live.

**Next:** joint calculator.

## Try it without any setup (demo mode)

Open `docs/index.html` through any web server (or the GitHub Pages link once it is published) while `docs/assets/js/config.js` has an empty `API_URL`.
Log in as `admin / admin123` or `fm01 / fm12345`. The data is sample data kept only in that browser.

## Setup, step by step

### 1. Google Sheet and backend (about 10 minutes)
1. Create a blank Google Sheet on the Google account you use for the other RTG dashboards. Name it e.g. `RTG Heater Store DB`.
2. In the Sheet, go to **Extensions → Apps Script**.
3. Delete what is in `Code.gs` and paste the whole content of **`dist/Code.gs`** from this repo. Save.
4. Open **Project Settings** (gear icon), tick *Show "appsscript.json" manifest file*, open `appsscript.json` and replace it with `backend/appsscript.json`. Save.
5. In the editor's function dropdown choose **`setup`** and press **Run**. Allow the permissions it asks for. Open **Execution log**: it prints the first login, `admin` with a temporary password. Write it down.
6. Optional: run **`loadSampleData`** to fill the empty tabs with SAMPLE heaters so you can try the app. Delete those rows before loading real data.
7. Fill the Sheet's **Settings** tab: `CompanyInbox` (your company mail), `AppUrl` (the GitHub Pages link from step 2.4), `RTGTeamMail` (told about new requests), `OverdueTo` / `OverdueCC` (daily overdue reminders and issue mails), `RejectCC`.
8. **Deploy → New deployment → Web app**. Execute as: *Me*. Who has access: *Anyone*. Deploy, and copy the **Web app URL** (ends in `/exec`).

9. Choose **`installTriggers`** in the function dropdown and press **Run** once. It schedules the overdue reminders (Settings `OverdueMailHour`, default 9 am) and the daily export (Settings `ExportTime`, default 6 pm). Google will ask for Drive and external-request permission the first time: the export makes a temporary copy without passwords, mails it and deletes it.

Whenever the code changes later: paste the new `dist/Code.gs`, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. The URL stays the same.

### 2. GitHub Pages
1. Put this folder in your GitHub repo.
2. Edit `docs/assets/js/config.js` and paste the Web app URL into `API_URL`. Commit.
3. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`** → Save.
4. After a minute the app is live at `https://<your-user>.github.io/<repo>/`. Log in as `admin`, set your own password, and add users from the **Users** page.

### 3. Loading real data
Fill `templates/RTG_data_templates.xlsx` (one tab per Sheet tab, with the same headers) and paste the rows into the matching tabs of the Google Sheet. Keep the header row unchanged.

### 4. Power Automate: save the daily export to the company folder
A second flow: **When a new email arrives (V3)**, Subject Filter `RTG-HEATER-EXPORT`, *Include Attachments* = Yes, *Only with Attachments* = Yes →
**Apply to each** attachment → **Create file** (SharePoint or OneDrive) in your folder with File Name `RTG-Heater-Export.xlsx` (a fixed name, so Power BI always reads the latest; turn on overwrite, or add a "Delete file" step before it).

### 5. Power Automate: send the app's mails from company mail
The script sends notification mails to `CompanyInbox` with the subject `[RTG-NOTIFY] <type> <number>`. The mail shows the readable message
(with a grey line saying who it is meant for) and carries a small attachment `rtg-notify.json` like:
```json
{"type":"REQUEST_REJECTED","ref":"RTGH0007","to":"vendor@x.com","cc":"rtg@x.com","subject":"Request RTGH0007 rejected","html":"<p>...</p>"}
```
Create one automated cloud flow:
1. Trigger **When a new email arrives (V3)** with *Subject Filter* = `[RTG-NOTIFY]`, *Include Attachments* = Yes. Optionally restrict *From* to the Google account's address.
2. **Parse JSON** with *Content* = the expression `base64ToString(triggerOutputs()?['body/attachments'][0]?['contentBytes'])` and this schema:
   ```json
   {"type":"object","properties":{"type":{"type":"string"},"ref":{"type":"string"},"to":{"type":"string"},"cc":{"type":"string"},"subject":{"type":"string"},"html":{"type":"string"}}}
   ```
3. **Send an email (V2)**: To = `to`, CC = `cc`, Subject = `subject`, Body = `html`.
4. Optional: **Move email** to a folder like `RTG-Notify/Done` so the inbox stays clean.

Mails are also logged in the Sheet's `MailOutbox` tab. Nothing is sent to people until this flow exists, so it is safe to set up last.

## Developer notes
- `shared/schema.json` is the single source of tab and column names. `shared/logic.js` holds the heater rules used by both the backend and demo mode.
- After changing anything in `shared/` or `backend/`, run `python3 tools/build.py` (needs `openpyxl`). It regenerates `backend/Schema.gs`, `backend/Logic.gs`, `backend/SampleData.gs`, `docs/assets/js/logic.js`, `docs/assets/js/sample-data.js`, `dist/Code.gs` and the Excel template.
- Tests: `npm test` runs the backend (and the pasted bundle) against an in-memory fake of the Sheet, including the full request → issue → return → maintenance lifecycle.
- Demo mode runs the **same backend code** in the browser (`docs/assets/js/gas-fake.js` + generated `backend-bundle.js`), so what you try in demo is what runs on Google.
- Chart.js 4.4.1 is bundled in `docs/assets/vendor/` (MIT), so the app works even where CDNs are blocked.
- Passwords are stored as salted SHA-256 hashes. Sessions last 6 hours of inactivity. Five wrong passwords lock the account for 15 minutes.
