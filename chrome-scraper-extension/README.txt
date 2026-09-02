========================================================================
  SCRAPESUITE  --  Quick Start Guide
========================================================================

A Chrome extension to pull post data (views, likes, comments, shares,
date, caption, link) from YouTube, Instagram, Facebook & LinkedIn into
Excel / CSV.


------------------------------------------------------------------------
1. INSTALL  (one time)
------------------------------------------------------------------------
1. Unzip "chrome-scraper-extension.zip".
2. Open Chrome and go to:  chrome://extensions
3. Turn ON "Developer mode" (toggle, top-right).
4. Click "Load unpacked" and select the unzipped
   "chrome-scraper-extension" folder (the one containing manifest.json).
5. Pin the extension so it's easy to reach.

   NOTE: Make sure you are LOGGED IN to the platform you want to scrape.


------------------------------------------------------------------------
2. BASIC SCRAPE  (grid data)
------------------------------------------------------------------------
1. Open a profile page, e.g.:
     - youtube.com/@channel/videos
     - instagram.com/username/reels/
     - a Facebook page's Reels tab
     - your LinkedIn feed
2. Scroll down to load as many posts as you want.
3. Click the extension icon -- it auto-detects the posts.
4. Tick "Infinite Scroll" then "Start Crawling" to auto-load more.
5. Click "Download Excel" (or CSV).

   You get: Caption, Views, Date, URL, Thumbnail
   (plus likes/comments/shares where the platform shows them,
    e.g. LinkedIn).


------------------------------------------------------------------------
3. DEEP SCRAPE  (full metrics: likes, comments, shares, date)
------------------------------------------------------------------------
On Instagram, Facebook and YouTube, the grid only shows part of the data
(a reel tile shows views but no caption; a post tile shows a caption
fragment but no views). The FULL record -- caption, views, likes, comments,
shares and date -- lives INSIDE each post. Deep Scrape opens each post and
reads all of it, so you get every column filled regardless of whether you
started on the Posts tab or the Reels tab.

1. Do a basic scrape first (section 2) so the post list is loaded.
2. Tick "Deep Scrape".
3. Choose the fields you need:
     Date, Likes, Comments, Shares  (and optionally "Comment text").
4. Set "Max posts" and "Delay" (keep the delay at 3+ seconds).
5. Click "Start Deep Scrape" -- it opens each post, reads the data,
   and fills the sheet. Progress is shown live.
6. Click "Download Excel" when it finishes.


------------------------------------------------------------------------
READ TEXT FROM IMAGES (OCR)
------------------------------------------------------------------------
Tick "Read text from images" and click "Read images". For each post it:
  - extracts the on-image text        -> Image Text column
  - buckets the content               -> Content Type column
      (Offer-led / Product-led / Festive / Informational)
  - detects the language              -> Image Language column

Uses PaddleOCR PP-OCRv4 (detection + recognition) via onnxruntime-web,
running FULLY ON-DEVICE (nothing leaves your browser). It is much stronger
than the old engine on stylized marketing text over busy backgrounds
(reel thumbnails, posters). Reads ENGLISH / Latin script. Each image takes
~2-4 seconds (it reads the full-size cover image, not the thumbnail).
Scrape first, then read.


------------------------------------------------------------------------
COST PER VIEW (CPV)
------------------------------------------------------------------------
Enter a Cost per view at the top (e.g. 0.30). An "Expected Investment"
column is added = CPV x views. Example: CPV 0.30 and 10,000 views ->
3,000. Clear the box to remove the column.


------------------------------------------------------------------------
GOOD TO KNOW
------------------------------------------------------------------------
- Every count has a plain column ("322K") AND a number column
  ("322000") so you can calculate/sort easily.

- Instagram & YouTube do NOT publish share counts -- that column will
  stay blank for them (no tool can retrieve it).

- Deep Scrape opens each post one-by-one, so it is slower
  (roughly: delay x number of posts). That is the only way to get the
  full per-post metrics.

- Keep the delay at 3 seconds or more to avoid the platform's anti-bot
  checks.

- You must stay logged in to the platform while scraping.

- If a column comes back blank, the platform may have changed its page
  layout. Report it (with the post URL) and it can be fixed quickly.


------------------------------------------------------------------------
SUPPORTED COLUMNS
------------------------------------------------------------------------
Caption | Duration | Duration (sec) | Views | Views (number) |
Likes | Likes (number) | Comments | Comments (number) |
Shares | Shares (number) | Date | URL | Thumbnail |
Expected Investment (when CPV set) | Comment Text (optional)

========================================================================
