========================================================================
  INSTANT DATA SCRAPER  --  Quick Start Guide
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
Caption | Views | Views (number) | Likes | Likes (number) |
Comments | Comments (number) | Shares | Shares (number) |
Date | URL | Thumbnail | Comment Text (optional)

========================================================================
