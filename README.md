# Saved Library for Instagram

You've saved hundreds of posts on Instagram. You can't search them, can't filter
them, and can't get them out. This extension fixes that.

It works in two steps, and that split is the whole idea:

1. **Scan** — reads the captions, creators, dates and thumbnails of your saved
   posts. Fast, tiny, and **downloads nothing**.
2. **Pick and download** — you browse your library, filter it, tick the posts you
   actually want, and only those get downloaded.

So having 3,000 saves is not a problem. You never download 3,000 things.

---

## Installing it

It isn't on the Chrome Web Store, so you load it yourself. Takes a minute.

1. Download this folder to your computer.
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** (top-left).
5. Select this folder — the one containing `manifest.json`.

The purple bookmark icon appears in your toolbar. Pin it for easy access.

> Loading an unpacked extension is normal and safe — it's how every Chrome
> extension is tested before it's published.

---

## Using it

### Step 1 — Scan your saves

1. Go to Instagram and open your saved posts
   (your profile → the bookmark icon, or a specific collection).
2. A small **Saved Library** panel appears in the bottom-right corner.
3. Click **Scan this collection**.

The page scrolls itself slowly while the counter climbs. Leave the tab open and
let it work — scanning 1,000 posts takes a few minutes, on purpose.

Scan each collection separately. Instagram only loads one collection at a time,
so the extension can only see the one you're looking at.

### Step 2 — Pick what you want

Click **Open my library** (in the panel, or from the toolbar icon). You get a
grid of everything you've scanned, with four ways to choose:

| I want… | Do this |
|---|---|
| Everything from one creator, or one collection, or one year | Set the filters, then **Select all matching** |
| Just these few | Tick the ones you want |
| Only what's new since last time | Tick **Only ones I haven't downloaded** |
| This one post, right now | Right-click it on Instagram → **Save this post to my library** |

You can also search captions — type `hiring`, `pricing` or `recipe` and see
every save that mentions it. For a marketer this is usually the most useful part
of the whole thing.

Before anything downloads you'll see **how many posts, how many files and roughly
how big**, and you have to confirm.

### Step 3 — Download

Click **Download selected**. Files go to your Downloads folder:

```
Downloads/
└── Instagram Library/
    ├── Ad Ideas/
    │   ├── 2023-11-14_growthmarketer_Abc123.mp4
    │   └── 2024-02-02_copychief_Xyz789_1.jpg   ← carousels are numbered
    ├── All Posts/
    └── saved-posts-2026-09-20.xlsx
```

**Export to Excel** gives you one row per post: collection, date, creator,
caption, likes, comments, views, the post link, and the exact file name on your
computer — so the spreadsheet and the folder always match up. It exports your
selection, or everything currently filtered if you haven't selected anything.

---

## Things worth knowing

**Downloads are deliberately slow.** Two files at a time, with a pause between
each. Grabbing a thousand files as fast as possible is exactly what gets an
account rate-limited. A big batch takes a while — that's the trade.

**"Link expired" means re-scan.** Instagram's media links stop working after a
day or so. If a download fails with that message, or a thumbnail goes blank,
re-scan that collection and download again. Your library keeps everything else.

**Instagram changes its website.** When they do, scanning may stop finding posts
until the extension is updated. This is the ongoing maintenance cost of anything
in this category, not a bug you can design away.

**It only sees your own saves.** It reads the data Instagram already sends to
your browser when you look at your own saved posts. It doesn't log in for you,
doesn't touch anyone else's account, and doesn't work while you're logged out.

**Nothing leaves your computer.** There is no server, no analytics and no account.
Your library lives in your browser; your files live in your Downloads folder.

**Before you publish it.** Instagram's terms of service restrict automated
collection of content, and Chrome Web Store reviewers do remove extensions in
this category. Personal, manual archiving of your own saves is a much safer
footing than a public listing. Get advice before going commercial with it, and
keep downloaded content for your own reference — re-publishing someone else's
work is a separate problem from downloading it.

---

## For whoever works on the code

```
manifest.json              Extension setup and permissions
src/page/interceptor.js    Reads the JSON Instagram already fetches (page world)
src/content/collect.js     Turns that JSON into clean post records
src/content/overlay.js     The scan panel on the Saved page
src/background/sw.js       Download queue, throttling, right-click capture
src/dashboard/             The library UI: filters, selection, export
src/lib/db.js              Local storage (IndexedDB)
src/lib/naming.js          File and folder naming (shared by downloader + Excel)
src/lib/xlsx.js            Dependency-free .xlsx writer
tests/                     Run with: npm test
```

`npm test` runs the normaliser against both of Instagram's response shapes and
checks the file-naming rules. Run it after any change to `collect.js` or
`naming.js` — those two files are where breakage shows up first.

No build step, no dependencies. Edit the files, hit reload on
`chrome://extensions`, done.

### What v1 deliberately leaves out

Facebook and LinkedIn, auto-tagging rules, and syncing the library to Notion or
Sheets. Instagram is where the pain is worst, and one platform is enough to
maintain while the idea proves itself.
