# v2.12 — Ad Libraries: build plan

Scope: user opens Meta Ad Library or Google Ads Transparency Center, extension
collects every ad, exports the two-sheet Excel with a screenshot per ad, renders an
HTML insights report in a new tab, and offers a choice of creative-text reader.

Decided. This document is the build spec, not an options paper.

---

## 1. What the reference output actually is

Read from the supplied `meta-ads-*.xlsx` (73 ads) and `meta-ads-insights-report-*.html`.

**Workbook — 2 sheets.**

`Executive Summary` (33 rows, label/value pairs, no images): title + generated timestamp,
then Total ads / Active / Inactive / Video creatives / Image creatives / Date range; then
blocks for Brand Details (brand, ads, active, inactive, verified, primary category, date
range), Advertisers Scraped, Top Landing Domains, Top CTAs, Offer Signals Detected.

`Meta Ads` (73 rows × 15 cols), columns in order:

| # | Column | Source | Notes |
|---|---|---|---|
| 1 | Brand | card | advertiser/page name |
| 2 | ID | card | stored as the rendered string `Library ID: 1075552802051653` |
| 3 | Status | card | Active / Inactive |
| 4 | Date | card | rendered string `Started running on 27 Sep 2026` |
| 5 | Asset type | DOM | Video / Image |
| 6 | CTA | card | `-` when the card shows none |
| 7 | Ad Preview Link | card | text `Open in Ad Library`, hyperlink to `facebook.com/ads/library/?id=…` |
| 8 | Landing Page | card | **displays** `samsung.com`, **hyperlinks** the full destination with UTM/fbclid intact |
| 9 | Headline | card | `-` on nearly every row in the reference file |
| 10 | Description | card | primary ad copy; multi-line (copy / display URL / headline) joined with newlines |
| 11 | Creative Duration | video | `20sec` |
| 12 | Creative Screenshot | screenshot | embedded JPEG, one per row |
| 13 | Type of creative | derived | product vertical, e.g. `Electronics & Gadgets` |
| 14 | Campaign Signals | derived | `General Product Ad` / `Brand Awareness (unconfirmed — no strong text signal)` / `Offer/Discount-led` |
| 15 | Creative Language | derived | `English (assumed)`, or a longer "not verified" note for video |

Mechanics confirmed from the OOXML: 73 `oneCellAnchor` drawings (one image per row),
146 hyperlinks (2 per row — ad preview + landing page), screenshots are JPEG with the long
edge capped at 600px and varying aspect (442×570, 338×600, 600×600).

**Report** — one self-contained HTML file. No `<script>` at all, a single `<style>`, inline
SVG icons, 74 base64 images, ~98 KB of markup carrying ~3.8 MB of images. Sections: header
with generated timestamp + ad count; a stat row (Total / Active / Inactive / Video / Date
range); then horizontal bar-chart cards for Advertisers scraped, Video vs display, Type of
creative, Campaign signals, Language breakdown, Top CTAs, Top landing domains, Offer signals
detected, Posting cadence by quarter; then a gallery of all creatives — screenshot, brand,
tag row (status / asset type / vertical / language), campaign-signal tag, date, copy, domain,
duration.

## 2. The architecture correction

My earlier note assumed we would parse the page's GraphQL. The reference output shows that is
**not** how this is done, and should not be how we do it:

- `ID` is `"Library ID: 1075552802051653"` — the rendered label, prefix included.
- `Date` is `"Started running on 27 Sep 2026"` — the rendered label, not a timestamp.
- `Ad Preview Link` is the literal link text `"Open in Ad Library"`.
- `CTA` and `Headline` are `-` wherever the card shows nothing, rather than being filled
  from JSON that would have had them.
- Screenshot aspect ratios match rendered card media areas, not source creative dimensions.

So: **read the rendered card, and screenshot the rendered card.** This is better for us than
JSON parsing on three counts. It survives GraphQL schema churn. It works identically on Google
ATC, whose RPC is an undocumented numeric-key protobuf. And — the important one — a viewport
screenshot is a **same-origin canvas image**, so OCR needs no CDN fetch, no
`cdninstagram`/`fbcdn` host permissions, and no tainted-canvas workaround. That removes the
single messiest part of v2.11.0's media path.

Keep `content/net_hook.js` as an **enrichment** layer only, where the JSON happens to be
there: exact start timestamps, and full ad copy where the card truncates behind "See more".
Never required; never blocking.

## 3. Build phases

Effort is working days, and assumes the capture files in §5 arrive first.

### P0 — Site adapters (2d)
- `detectPlatform()` gains a **path test ahead of the hostname test**. Today
  `facebook.com/ads/library/` returns `'facebook'` and is fed to `extractFacebook()`, which
  will emit garbage. New platforms: `metaads`, `googleads`.
- `extractMetaAds()` / `extractGoogleAds()` producing the 15-column schema above, with a new
  `ADS_COLUMNS` constant — `SOCIAL_COLUMNS` does not fit and must not be stretched.
- Auto-scroll collector: reuse the existing crawl loop, dedupe on library/creative id, keep a
  running count for the popup ("ADS COLLECTED — 73"), persist to `chrome.storage.session` so
  a popup close does not lose the set.

### P1 — Screenshot pipeline (2d)
- Content script scrolls each card into view and reports `getBoundingClientRect()` + `devicePixelRatio`.
- Service worker calls `chrome.tabs.captureVisibleTab`. **Throttle to ~2 captures/second** —
  Chrome enforces `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` and will start throwing above it.
  73 ads ≈ 40s. Progress + Stop in the popup, same control pattern as Deep Scrape.
- Offscreen document crops the viewport PNG to the card rect, downscales the long edge to 600,
  encodes JPEG ~0.8. The offscreen doc already exists for OCR; this is one more canvas path.
- Store blobs in **IndexedDB**, not `storage.local` (that quota is 10 MB; 73 screenshots plus a
  report comfortably exceeds it).

### P2 — Workbook writer v2 (2d)
Our xlsx writer is hand-rolled, so embedded images are real OOXML work:
`xl/media/*.jpeg`, `xl/drawings/drawing1.xml` with one `oneCellAnchor` per row,
`xl/drawings/_rels`, `[Content_Types]` entries for `jpeg`, per-row heights sized to the
image, and `<hyperlink>` + sheet rels for the two link columns. Plus the `Executive Summary`
sheet generator. Validate by round-tripping the result through the same reader I used on the
reference file.

### P3 — Insights report (1.5d)
Template producing the section set in §1 — no JS in the output, inline SVG, base64 images,
one `<style>`. Rendered into an extension page opened with `chrome.tabs.create`, reading the
run from IndexedDB, with a Download button writing the standalone file via `chrome.downloads`.
Charts are CSS bar rows; no chart library, so nothing to bundle and no CSP exposure.

### P4 — Creative-text reader choice (1.5d)
Dialog with three options, matching the reference:
- **Free Offline Reader** — our existing PP-OCRv4. Already built; becomes the no-key default.
- **Google Gemini** — key pasted by the user, `generativelanguage.googleapis.com`.
- **Anthropic Claude** — key pasted by the user, `api.anthropic.com`; browser calls need the
  `anthropic-dangerous-direct-browser-access: true` header.

Keys in `chrome.storage.local` on that machine only, never synced, never sent anywhere but the
chosen provider. Shared progress/stop UI across all three. The hosted options also give video
summaries, which frame-OCR cannot; our v2.11.0 frame OCR stays as the offline path for video.

### P5 — Google ATC adapter (1.5d)
Same card-reading and screenshot pipeline, different selectors and a third sheet
(`Google Ads`), plus `Advertiser ID` / `Verified advertiser` / `Region` columns. Cheap because
P1–P4 are platform-agnostic by construction.

### P6 — Store compliance (1d)
New host permissions (`adstransparency.google.com`, and the two API hosts if the hosted
readers ship) with justifications; single-purpose description rewritten to cover ad libraries.

**The disclosure consequence, stated plainly:** today we tell the Store and the user that
everything is processed on-device and nothing leaves the browser. The moment Gemini or Claude
is selected, ad creatives are transmitted to a third party. The data-usage disclosure and the
privacy policy both have to change, and the dialog must say so on screen. This does **not**
change the remote-code answer — an API call is data, not code, so that stays "No".

**Total ≈ 11.5 days**, Meta-only usable at the end of P3 (~6 days).

## 4. What this subsumes

Three of the five open feedback items are absorbed rather than added:
- #5 (Offer Type column) → `Campaign Signals` + the Offer Signals Detected block.
- #8 (why top performers win) → the report's cross-ad analysis.
- #9 (Raw-tab analysis) → the report, generalised to posts as well as ads.

Caption auto-fill (#1) and the single-dataset download flow (#7) remain separate and still
apply to the social-post side.

One honest observation on the reference output, to set the quality bar: `Type of creative` is
`Electronics & Gadgets` for all 73 rows, `Campaign Signals` is
`Brand Awareness (unconfirmed — no strong text signal)` on 32 of 73, `Headline` is `-` on
nearly every row, and `Creative Language` is a 150-character hedge repeated as a tag. The
format is good and worth matching exactly; the analysis inside it is thin. Our OCR plus the
offer-type work already queued should fill those columns better than the reference does.

## 5. What I need from you

**Two capture files**, one per site, using `tools/capture_ads_payloads.js`:

1. Open `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=IN&q=samsung`
   logged in as normal.
2. F12 → Console. If Chrome refuses the paste, type `allow pasting` and Enter.
3. Paste the whole file, Enter.
4. Run `__ssCapture.cards()` — it must report a non-zero ad-card count. If it reports 0, say so
   and I will widen the selectors.
5. Scroll ~20 seconds so more ads load, then run `__ssCapture.save()` and send the file.
6. Repeat on `https://adstransparency.google.com/?region=IN` for a brand with plenty of ads.

The file records the rendered card markup, each card's on-screen rectangle, the links with
their tracking parameters intact, and any ad JSON the page fetched. It never records request
bodies or headers, scrubs tokens, and only writes a local file.

That is the whole blocker. With those two files the selectors and parsers are written against
real markup and tested in real Chrome the way `test_extension_e2e.js` already runs. Without
them I would be guessing at DOM structure — which is how the Duration column shipped broken in
v2.10.0, and I am not repeating that.

**One decision I need from you:** ship the hosted readers (Gemini/Claude) in v2.12, or keep
v2.12 offline-only and add them in v2.13? They are the only part that changes what we tell the
Store and the user about data leaving the device, and that disclosure change is the slowest
thing to get through review. Everything else proceeds regardless.
