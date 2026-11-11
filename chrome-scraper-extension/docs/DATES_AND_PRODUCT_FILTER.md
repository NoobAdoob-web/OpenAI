# Dates on every post, and filtering by product

Two features users asked for. They share one dependency — knowing what each
post says and when it was published — so they are planned together.

Status: Instagram and YouTube dates are **built and tested** (see
`content/post_dates.js`, `test_post_dates.js`, 31/31). Everything else below
is specified, not yet written.

---

## 1. Dates on every post

### The real goal is the filter, not the column

Users do not want a date column; they want "give me the last three months".
That changes the architecture, because feeds are reverse-chronological: once a
scroll reaches posts older than the cutoff, **there is nothing left worth
loading**. So the control changes from

    Number of scrolls: [20]            ->    From [2026-08-01] to [today]

and the crawl stops itself. On a profile with 2,000 posts, asking for the last
quarter stops after a few screens instead of scrolling the lot. That is a
faster, cheaper and more honest product than scraping everything and filtering
afterwards.

**Guard against non-chronological items.** Pinned posts sit at the top out of
order, and a channel's Videos tab can be sorted by popularity. So: never stop
on the first old post. Keep scrolling until N consecutive posts (N≈12, about
one screen) are all older than the cutoff, and ignore items flagged as pinned.
If the first screen is not in descending date order at all, fall back to a
plain scroll count and filter at the end, and say so in the status line.

### Instagram — solved, exactly, with no network requests

Instagram encodes the post's creation time **in its own URL**. The shortcode in
`/p/<code>/` is the numeric media id in URL-safe base64, and the top 41 bits of
that id are the creation time in milliseconds from Instagram's epoch
(1314220021721).

Verified today, two independent ways:

- The shortcode→id step matches six published test vectors from an independent
  implementation exactly.
- The epoch is pinned by a post whose date is externally knowable:
  `DCF76aqtL2Y` is MLB's World Series trophy photoshoot. This epoch decodes it
  to **2024-11-08**, nine days after the 2024 World Series ended. The competing
  epoch found online (1293840000000) gives 2024-03-17 — seven months *before*
  the Series — so it is wrong. Decoded dates also increase monotonically across
  the shortcode eras (B≈2017-18, C≈2020-21, D≈2024+).

Consequence: Instagram goes from **~7% of rows dated** (measured on a real
204-row export, where the grid DOM has no date and the API only sometimes
carries one) **to 100%, instantly, offline**. The grid already gives us every
post's URL, so the date is free. This also means the crawl knows a post's date
the moment it appears, which is exactly what the stop-at-cutoff loop needs.

### YouTube — solved, approximately

Every video in the grid prints a relative date ("5 days ago"), confirmed on a
live channel page. Parsed to an absolute date, with the precision recorded
honestly: day-level up to "weeks ago", **approximate** for "months"/"years"
ago. Good enough to filter on; a new `Date precision` column says which it is,
so nobody mistakes an estimate for a fact. Exact dates still need opening the
video, which stays optional.

### Facebook — not solved, and I need your help

Facebook post ids (`pfbid…`) are opaque and carry no timestamp, so there is no
equivalent trick. Logged out, facebook.com redirects straight to a login wall,
so I cannot inspect a real page from here. Three candidate routes, in order of
preference, to be decided once I can see real markup:

1. The rendered card's own relative/absolute date text, if present.
2. The page's own API responses, via the MAIN-world hook already shipped.
3. A per-post pass, which is reliable but costs ~2-3s per post.

---

## 2. Filtering by product

For a brand running many lines at once — S24, S25, A36, refrigerators, TVs,
washing machines — users want one product's posts, not the whole feed.

### Detection, in three layers, on-device

1. **Hashtags are the strongest signal** and are already in the caption:
   `#GalaxyZFold8`, `#GalaxyS26FE`. Split camel case, strip the brand prefix.
2. **Model tokens**: alphanumeric patterns near a product word — `S24`,
   `S25 Ultra`, `A36`, `M55`, `Z Fold8`, `Watch Ultra2`, `Book5`.
3. **Category lexicon** for non-model lines: refrigerator/fridge, TV,
   washing machine, air conditioner/AC, soundbar, microwave, laptop, tablet,
   earbuds, monitor.

Input text is caption + headline + hashtags + whatever OCR read off the
creative — which is why the image/video text reading already shipped matters
here: a post with no caption often still names the product on screen.

### The UI is discovery, not a search box

After a scrape, show what was actually found, with counts:

    Products found:
      [x] Galaxy S26 (42)   [x] Z Fold8 (31)   [ ] Watch Ultra2 (12)
      [ ] Refrigerator (8)  [ ] Washing machine (5)   [ ] Unmatched (19)

Ticking filters the export. A free-text box handles anything the detector
missed, and the discovered names are editable so two spellings can be merged
("S26" + "Galaxy S26"). Every row also gets a **Product** column, so the
unfiltered sheet can still be pivoted in Excel.

**"Unmatched" is shown on purpose.** A filter that silently drops posts it did
not understand is worse than useless for this job. The count makes the
detector's blind spots visible.

### Caption coverage is the limiting factor

Product detection is only as good as the text. On Instagram grids the DOM
carries no caption, and the API carries one for a minority of posts. A finding
from today that helps: **`instagram.com/p/<code>/embed/captioned/` renders
logged-out** and yields the caption, like count and comment count — confirmed
on a live post. It is lighter than loading the full post page, though it still
needs a real render rather than a plain fetch, so it is a cheaper version of
the existing per-post pass rather than a free one. Worth measuring against the
current deep scrape before choosing a default.

---

## Build order

| | Work | Days | State |
|---|---|---|---|
| A | Instagram + YouTube date recovery | 1 | **done** |
| B | Date columns wired into every extractor and the export | 1 | |
| C | From/To date controls + stop-at-cutoff crawl + overshoot guard | 2 | |
| D | Facebook dates | 1.5 | blocked on recon |
| E | Product detection + Product column | 2 | |
| F | Product discovery UI + filtered export | 1.5 | |
| G | Caption backfill, whichever route measures best | 2 | |

≈11 days, of which the hardest single piece is already finished.

## What I need from you

1. **Captures from your logged-in browser**, using
   `tools/capture_ads_payloads.js` — paste into the console, scroll ~20s, run
   `__ssCapture.save()`. One on an **Instagram profile grid**, one on a
   **Facebook page's posts**, one on a **YouTube channel's Videos tab**. Both
   Meta sites hard-wall logged-out, so this is the one thing I cannot do
   myself. Facebook's is the important one.

2. **One of your real exported sheets** that has Instagram URLs and some dates
   already filled. I want to check the decoder against your data, not only
   against public test vectors — if a decoded date disagrees with one your
   export already had, I need to know before this ships.

3. **A product list for one brand you care about** — roughly how you would
   expect the posts to be grouped. Twenty lines is plenty. It is the test set
   for the detector, and tells me whether you think of "Galaxy S26" and
   "Galaxy S26 FE" as one product or two.

Items 2 and 3 are quick. Item 1 is the only blocker, and only for Facebook.


---

# Appendix: measured against five real exports (11 Nov 2026)

Five workbooks from live runs — two YouTube (30 rows each), two Instagram
(18 and 78 rows), one Facebook (90 rows). What they show:

## Coverage today, before any of this work

| | Caption | Date | Views | Likes | Comments | Duration |
|---|---|---|---|---|---|---|
| YouTube | 100% | 100%* | **0%** | **0%** | **0%** | 100% |
| Instagram (78 rows) | 37% | **37%** | 100% | 100% | 100% | 3% |
| Facebook (90 rows) | **0%** | **6%** | 100% | **0%** | **0%** | 6% |

\* YouTube's "date" is the raw relative string, not a date — see below.

## Instagram: the decoder is validated and is a large win

Decoded a date for **78/78 (100%)** of posts, against 37% today.

Of the 29 rows that already had a date, **26 match exactly** when rendered in
the timezone they were recorded in (IST). The three that differ are each
exactly **one day early**, at posting times indistinguishable from the 26 that
agree — so this is not a timezone or rounding effect. It is the shortcode
carrying the media's *creation* time, which for a scheduled post precedes
publication.

The error is **bounded and one-directional — never late**. So:

- a decoded date never overwrites one the API supplied;
- its precision is reported as `upload`, not `exact`;
- date-range filtering widens the start of the range by `UPLOAD_SKEW_DAYS`
  (1), so a post uploaded the day before it went live is not silently dropped.

These 29 pairs are committed as `tools/fixtures/ig_known_dates.json` and
asserted in `test_post_dates.js`, so a future change that regresses this fails
the suite.

## YouTube: a bug the real data caught

Exports contain **`"5d ago"`**, not `"5 days ago"` — and one row carried a real
date (`2026-11-06`), so the column mixes formats. The original parser only
matched the long form and would have failed on every YouTube row. It now
handles the compact form too (`45m`, `20h`, `5d`, `3w`, `2mo`, `1y`, with `mo`
correctly beating `m`).

Separately, and outside this plan's scope: YouTube Views, Likes and Comments
are **0% filled**. That is a bigger hole than dates were, and worth its own
fix.

## Facebook: no shortcode trick exists — confirmed, not assumed

Facebook reel URLs carry a numeric id, so the obvious hope was that it encodes
a timestamp like Instagram's. It does not. Against the five dated rows:

    2026-10-07 -> 1346074614070595
    2026-10-14 -> 3303206513202412
    2026-10-27 -> 1668806331423782
    2026-11-03 -> 2114398449467041
    2026-02-25 -> 1449344499914716

Non-monotonic: a post two weeks later has an id less than half the size. These
ids are not time-ordered, so no decoding is possible. Facebook dates must come
from the rendered card or the page's own API responses, which still needs a
capture from a logged-in browser.

Facebook is also the weakest platform overall — caption, likes and comments are
all 0% — so that capture buys far more than dates alone.
