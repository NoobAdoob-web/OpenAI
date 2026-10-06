# ChatLens — Phase 0 guide for the founder

Phase 0 has one job: **prove the extension can read members, votes and messages
accurately on a real WhatsApp account**, and measure how much message history is
actually searchable. There are no real screens yet, only a bare test panel.

> **Use a separate test WhatsApp number, never your main account** (PID section 16).

---

## 1. Install the test build (about 2 minutes)

1. Download `chatlens/releases/chatlens-phase0-v0.0.1.zip` and unzip it
   (double-click on Mac; right-click → Extract All on Windows). You get a folder
   called `chatlens-phase0-v0.0.1` with a file called `manifest.json` inside.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (switch at the top right).
4. Click **Load unpacked** and choose that unzipped folder (the one that
   contains `manifest.json`). Keep the folder; Chrome loads it from there.
5. Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next to
   **ChatLens (Phase 0 test build)**.
6. Open (or **reload**) `https://web.whatsapp.com` and log in with the test number.
7. Click the ChatLens icon. A panel opens on the right.

If the panel says **Reload WhatsApp Web**, reload the WhatsApp tab once. That
happens right after installing or updating.

## 2. What the panel shows

| Section | What it tells you |
|---|---|
| **Status** (top right) | Ready · Open WhatsApp Web · Log in to WhatsApp Web · Paused for update |
| **Health check** | Every reading function, tested on your account. A ✗ means "Paused for update". |
| **Poll Chaser test** | Pick a poll in the open group, tap **Check poll**: members, who voted, who hasn't. |
| **Search coverage report** | Tap **Measure**: how many messages this computer holds, how far back, and whether the text is readable. |
| **Diagnostics** | Tap **Copy diagnostics**: technical facts (versions, which data sources worked, counts). **No names, numbers or messages.** |

## 3. What to test (the Phase 0 gate)

Set up these groups on the test number (PID section 16):

- [ ] **Small group** (about 5 people) with a poll. Easy to count by hand.
- [ ] **Two members with the same name** (save two contacts both as "Rahul").
- [ ] **Someone who voted, then left the group.**
- [ ] A **multiple-choice poll**.
- [ ] A poll where **nobody** voted, and one where **everyone** voted.
- [ ] Bonus: set WhatsApp Web to **Hindi** and **dark mode**, then check again.

For each poll:

1. Open the group in WhatsApp Web and scroll so the poll is visible.
2. In the panel, tap **Reload polls**, pick the poll, tap **Check poll**.
3. **Count by hand** in WhatsApp (open the poll's "View votes" and the group's
   member list) and compare: members, voted, haven't voted, voted-then-left.
4. Write down whether it matched exactly. One wrong list = gate not passed.

Then tap **Measure** once on each test account and note the numbers.

**Finally, tap Copy diagnostics and paste the result back to Claude**, together
with your hand counts. That tells us exactly which reading routes worked on the
real WhatsApp Web, and what to fix.

## 4. What to expect honestly

WhatsApp doesn't publish how WhatsApp Web works inside. This build reads it
the way open-source tools do, and tries several routes for each piece of data
(memory first, then WhatsApp's own database on the computer). Some routes may
not work on today's WhatsApp version. That is normal for Phase 0, and why it
exists. When a route fails, the panel shows an error or "Paused for update"
**instead of a wrong list**. That is the design working (rule "accurate or silent").

One thing to watch: if the panel shows **"the vote total could only be read from
one place"**, the poll result was not cross-checked automatically. Your hand
count is the only check in that case.

## 5. Safety in this build

- It **never sends** anything. There is no code that presses Send or Enter. An
  automatic check blocks any build that contains such code (rule S1).
- It **only reads when you click** something in the panel, and only in the
  WhatsApp tab you are looking at (rule S2).
- It **never scrolls or loads older messages** by itself (rule S10).
- **Nothing leaves your computer.** This build makes no internet calls at all.
  An automatic check confirms it (rules P1, P2).
- It asks Chrome for the minimum permissions: the side panel and
  web.whatsapp.com. Nothing else.

## 6. For the developer: running the checks

From `chatlens/extension`:

```bash
npm install
npm run check        # type check, lint (incl. no-send rule), unit tests, build, no-send scan, network scan
npm run zip          # makes .output/chatlens-<version>-chrome.zip
npm run smoke        # end-to-end test against a FAKE WhatsApp page (needs Playwright + Chromium)
```

`npm run dev` opens Chrome with the extension loaded and reloads on every change.
