# Moving the app to Supabase

The app keeps working exactly the same. Only the place the data lives changes, from the Google Sheet to a Supabase database, which
answers in well under a second instead of 1 to 3 seconds.

- **Server**: `supabase/functions/rtg/`, an Edge Function. It runs the same backend code as the Google Sheets version (`backend/*.gs`),
  so every rule, number format and mail is identical. GitHub puts it on Supabase by itself whenever it changes.
- **Database**: Supabase Postgres. The function makes its own tables the first time it runs, so no SQL needs to be pasted.
- **Checklist photos**: Supabase Storage (private).
- **Mail, daily export, overdue reminders**: still from Google. `supabase/Relay.gs` is a small extra file in your existing Apps Script
  project. Every 5 minutes it sends the mails the app has queued (to the company inbox, the same as now), each morning it runs the
  overdue reminders, and each evening it copies all the data back into your Google Sheet and mails the daily export. So the Google Sheet
  stays a complete, readable backup.

## Space on the free plan

| | Free limit | Expected use |
|---|---|---|
| Database | 500 MB | a few MB a year (requests, tickets, logs) |
| Photos (Storage) | 1 GB | about 50 MB a year (photos are shrunk on the phone before upload) |

Admins see both meters on the **Users** page. They turn red at 80%. The free plan pauses a project after 7 days with no use; the relay
calls Supabase every 5 minutes, which keeps it awake.

## Steps (one time, about 20 minutes)

### 1. Make the Supabase project
1. Go to <https://supabase.com> and press **Start your project**. Sign in with your GitHub account.
2. Press **New project**. Name: `rtg-heater`. Set a database password and keep it somewhere safe (you won't need it for the app).
   Region: **Mumbai (ap-south-1)**. Press **Create new project** and wait about 2 minutes.
3. Open **Project Settings → General** and copy the **Project ID** (16 letters, like `abcdefghijklmnop`). This is not a secret.

### 2. Let GitHub put the server on Supabase
1. Open <https://supabase.com/dashboard/account/tokens>, press **Generate new token**, name it `github deploy`, and copy the token.
   It is shown only once.
2. In GitHub open the repository → **Settings → Secrets and variables → Actions → New repository secret**, and add two secrets:
   - `SUPABASE_ACCESS_TOKEN` = the token from step 1
   - `SUPABASE_PROJECT_REF` = the Project ID
3. Open the **Actions** tab → **Deploy Supabase function** → **Run workflow**. After about a minute it shows a green tick.
   From now on every change to the server is put on Supabase automatically.

### 3. Copy the data and connect the mail
1. Open your Google Sheet → **Extensions → Apps Script**.
2. Next to **Files**, press **+ → Script** and name it `Relay`. Delete what is in it and paste everything from
   [`supabase/Relay.gs`](supabase/Relay.gs).
3. On the line `var SUPABASE_FUNCTION_URL = ...` put your address: `https://<Project ID>.supabase.co/functions/v1/rtg`. Press **Save**.
4. At the top choose **connectSupabase** and press **Run**. Google asks for permission once more (to talk to Supabase); allow it.
5. The Execution log shows something like `Copied 22 tabs and 3 checklist file(s) to Supabase.` That copies every user (with their
   passwords), heater, request, ticket, consumable and log, and the maintenance checklists from Drive.

### 4. Switch the app over
Tell Claude it is done. Claude changes one line (`docs/assets/js/config.js`) so the website and the Android app talk to Supabase.
After that everyone logs in once more with the same user ID and password.

Do step 3 and step 4 close together. Anything entered in the app between them goes only to the Google Sheet, and the evening copy
from Supabase then overwrites it.

## If something goes wrong
- **Go back to Google Sheets**: in Apps Script run `disconnectSupabase`, and ask Claude to point `config.js` back to the Apps Script address.
  The Sheet has everything up to the last evening copy.
- **Copy the data again** (only before going live): run `copyDataAgain`. It replaces everything on Supabase with the Sheet.
- **Admin locked out**: run `resetAdminPasswordSupabase`. The new temporary password is in the Execution log.
- **Mails not arriving**: in Apps Script open **Executions** and look at `relayMailTick`.
