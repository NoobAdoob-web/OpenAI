# Poll Checker: test guide

This build does **one thing**: open a WhatsApp group with a poll, and see who
has voted and who hasn't. Nothing else.

> Test with a **separate test WhatsApp number** first, not your main account.

## 1. Install (2 minutes)

If you installed the earlier test build, remove it first: open `chrome://extensions`,
find **ChatLens (Phase 0 test build)**, click **Remove**.

1. Download `chatlens/releases/chatlens-poll-checker-v0.1.1.zip` and unzip it
   (double-click on Mac; right-click → Extract All on Windows). You get a folder
   with a file called `manifest.json` inside. Keep this folder.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (switch at the top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Pin it: puzzle-piece icon in Chrome's toolbar → pin **ChatLens Poll Checker**.
6. **Reload your WhatsApp Web tab.** This matters: the extension only joins tabs
   opened or reloaded after installing. Wait until your chats appear.
7. Click the extension icon. A panel opens on the right.

## 2. Use it

1. In WhatsApp Web, open a group that has a poll, and scroll until you can see the poll.
2. The **Status** list in the panel should show all green ticks.
3. Pick the poll and tap **Check votes**.
4. You see **Haven't voted**, **Voted** (with what each person chose), and
   **Voted, then left** if anyone left the group after voting.

## 3. If something isn't right

The **Status** list shows exactly which step failed, and what to do, in plain words.
If a step stays red, or a result looks wrong:

1. Take a screenshot of the panel.
2. Tap **Copy details for Claude** at the bottom and paste it to Claude, with the
   screenshot. The details hold no names, numbers or messages, only which
   steps and reading routes worked.

## 4. What to check (please count by hand once)

- [ ] A small group (about 5 people) with a poll. Do the lists match?
- [ ] A group with two people who have the same name.
- [ ] Someone voted, then left the group.
- [ ] Someone changed or removed their vote.
- [ ] A poll where several answers are allowed.

## 5. What it never does

- Never sends a message, never presses any button in WhatsApp.
- Reads only while the panel is open, and only the group you're looking at.
- Nothing leaves your computer. The extension makes no internet calls at all.
- If it can't be sure a list is right, it shows an error instead of a wrong list.

## For the developer

From `chatlens/extension`: `npm install`, then `npm run check` (types, lint
including the no-send rule, unit tests, build, no-send and network scans),
`npm run smoke` (end-to-end against four fake WhatsApp pages), and `npm run zip`.
