# Task List Colors for Google Calendar

A Chrome extension that colors Google Tasks in Google Calendar by the task list they belong to, and lets you show or hide each list from **My calendars**, the same way you do with calendars.

- **One color per list.** Every task chip gets its list's color in Day, Week, Month, 4-day and Schedule views, plus the task details popup. Past-day tints, borders and month-view dots keep the shading Calendar uses for its own calendars.
- **Show or hide lists.** Each task list gets its own row under the native **Tasks** entry in **My calendars**, with a checkbox in its color. Uncheck a list to hide its tasks.
- **Native menus.** Hover a list and click **⋮** to get Calendar's own menu layout: *Display this only*, *Show all task lists*, and the 24-color calendar palette with a custom color option.
- **Looks native.** The list rows are built from Calendar's own "Tasks" row at runtime, and the menus use Calendar's Material 3 color tokens. Light and dark themes both work, and the UI keeps matching when Google updates Calendar's styling.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (the one that contains `manifest.json`).
3. The extension ID should be **`mnjjhjbejppipnnpboiphjfcfopnfncn`**. The `key` in `manifest.json` pins that ID so it never changes, which keeps the OAuth redirect URI below valid.

It also works in other Chromium browsers that support `chrome.identity.launchWebAuthFlow` (Edge, Brave, Arc, Vivaldi).

## One-time Google Cloud setup (about 5 minutes)

Calendar's web page doesn't say which list a task belongs to. The extension gets that from the official Google Tasks API with read-only access. Google requires every app that uses the API to have its own OAuth client, so you need to create one. It's free.

1. **Create a project.** Go to <https://console.cloud.google.com/projectcreate>. Any name works, for example "Task List Colors".
2. **Enable the Tasks API.** Open <https://console.cloud.google.com/apis/library/tasks.googleapis.com> and click **Enable**.
3. **Configure the consent screen.** Open <https://console.cloud.google.com/auth/overview> and click **Get started**:
   - App name: anything, for example "Task List Colors". Support email: yours.
   - Audience: **External**.
   - Contact email: yours. Agree to the policy and click **Create**.
   - Then go to **Audience** and pick one of these:
     - **Publish app** (recommended). Google shows a one-time "Google hasn't verified this app" screen when you connect; click **Advanced → Go to Task List Colors**. You won't have to reconnect.
       Publishing requires a home page and privacy policy on the **Branding** page. You can use this project's site:
       - Application home page: `https://psychemm.github.io/TaskPlus/`
       - Application privacy policy link: `https://psychemm.github.io/TaskPlus/privacy.html`
       - Application terms of service link: `https://psychemm.github.io/TaskPlus/terms.html`
       - Authorized domains: `psychemm.github.io`
       - Leave the logo empty. Uploading one sends the app to Google's verification review.
     - Or stay in **Testing** and add your Google account under **Test users**. Testing-mode sign-ins expire after 7 days, so you'll click **Reconnect** in Calendar about once a week.
4. **Create the OAuth client.** Open <https://console.cloud.google.com/auth/clients> and click **Create client**:
   - Application type: **Web application**
   - Authorized redirect URIs → **Add URI**:

     ```
     https://mnjjhjbejppipnnpboiphjfcfopnfncn.chromiumapp.org/
     ```

   - Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
5. **Connect.** Click the extension's toolbar icon, open **Google Cloud setup**, paste the client ID, and click **Save**.
   On Windows you can instead run `powershell -STA -ExecutionPolicy Bypass -File tools\set-client-id.ps1`, paste it into the dialog, and click **Save**. That writes a git-ignored `config.json` that the extension reads automatically. Then click **Connect Google Tasks** in the popup, or **Connect** under *My calendars* in Calendar. Pick the same Google account you use in Calendar.

## Using it

- Open Google Calendar. Your task lists appear under **My calendars**, below **Tasks**.
- **Hide or show a list:** click its row or checkbox.
- **Change a list's color:** hover the row, click **⋮**, and pick a color. Click **+** for any custom color.
- **Focus on one list:** **⋮ → Display this only**. Bring the others back with **⋮ → Show all task lists**.
- The native **Tasks** checkbox still turns all tasks on or off. While it's off, the list rows are dimmed.
- Each list starts with its own color. Your default list keeps Calendar's Tasks color and the other lists get distinct palette colors. Colors and visibility sync across your Chrome profiles through `chrome.storage.sync`.

New tasks are picked up automatically, usually within a few seconds. Task data also refreshes every 5 minutes while Calendar is open, and when you come back to the tab.

## How it works

| Piece | What it does |
| --- | --- |
| `src/background.js` | Signs in with `chrome.identity.launchWebAuthFlow` (implicit grant, `tasks.readonly` and `email` scopes) and fetches every task list and its dated tasks from the Tasks API. It builds a compact *task → list* index in `chrome.storage.local`. The access token lives only in `chrome.storage.session`. |
| `src/content/chips.js` | Finds task chips (`[data-eventchip][data-eventid^="tasks_"]`) and looks up each task's list. It replaces every inline color that is a shade of the Tasks calendar color with the same shade of the list color, and keeps text readable on light colors. |
| `src/content/sidebar.js` | Clones Calendar's own **Tasks** row in *My calendars* (`[data-id]` is base64 of `tasks@tasks.google.com`), strips Calendar's script hooks, and renders one row per list. |
| `src/content/menu.js` | The per-list options menu and color palette. |
| `src/content/main.js` | A `MutationObserver` that re-applies everything after Calendar re-renders, and schedules data refreshes. |
| `src/options/` | The toolbar popup and options page: setup, connection status, connect and disconnect. |

Tasks are matched to lists by ID first. If an ID can't be found (for example, a recurring task instance), the extension falls back to title and date. It also learns from the **Task list** line whenever you open a task's details popup.

## Privacy

Full policy: <https://psychemm.github.io/TaskPlus/privacy.html> (source in [`docs/privacy.html`](docs/privacy.html)).

- Access is read-only (`https://www.googleapis.com/auth/tasks.readonly`). The `email` scope is used only to remember which account you connected.
- Requests go straight from your browser to Google. There is no server and no analytics.
- The task index (IDs, titles and due dates of dated tasks) is stored locally in `chrome.storage.local`. **Disconnect** deletes it and revokes the token.

## Limitations

- Hiding a list removes its chips, but in Month view Calendar's "+N more" counts and row heights don't change, because Calendar computed them before the extension ran.
- Google doesn't publish Calendar's markup and changes it from time to time. The extension relies on stable hooks (`data-eventid`, `data-taskid`, the Tasks calendar's `data-id`, and ARIA roles) rather than generated class names, but a large Calendar redesign could still require an update.
- The UI text is English only.

## Project layout

```
manifest.json
icons/                 toolbar and store icons
src/background.js      OAuth + Google Tasks API + task→list index
src/content/           scripts injected into calendar.google.com
  core.js              namespace, palette, color math, tooltip
  store.js             preferences and data from chrome.storage
  chips.js             recolor and hide task chips and popups
  menu.js              per-list options menu
  sidebar.js           task list rows under My calendars
  main.js              observer and refresh scheduling
  content.css
src/options/           popup and options page
docs/                  project website (GitHub Pages): home page and privacy policy
```
