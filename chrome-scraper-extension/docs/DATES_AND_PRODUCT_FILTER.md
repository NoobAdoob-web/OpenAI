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
