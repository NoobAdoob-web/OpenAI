# Feasibility: Meta Ad Library + Google Ads Transparency Center

Status: assessment only, nothing built yet. Written for the v2.12 scope decision.

## Verdict first

| | Meta Ad Library | Google Ads Transparency Center |
|---|---|---|
| Feasible in this extension? | **Yes** | **Yes** |
| Needs new technique? | **No** — same MAIN-world passive hook as v2.11.0 | **No** — same hook |
| Official API as an alternative? | Partly (see below) | Effectively no |
| Effort | ~2–3 days | ~2–3 days |
| Main risk | Meta's anti-automation terms | Undocumented internal RPC that can change without notice |

Both are the **easiest new sites we could add**, because they are ad *transparency* surfaces:
the data is public by design, and — crucially — both pages fetch their results as JSON that
`content/net_hook.js` can already read. We are not inventing anything; we are pointing
existing machinery at two new hostnames.

---

## Why this is cheap for us specifically

v2.11.0 already solved the hard problem on Instagram: the DOM does not contain the data
(captions, exact counts, durations), so `net_hook.js` runs in the **MAIN world at
`document_start`**, passively watches the page's own `fetch`/`XHR` responses, buffers them,
and replays them to the content script over a `ready` handshake.

Both ad libraries are the same shape:

- **Meta Ad Library** (`facebook.com/ads/library/`) renders from GraphQL responses.
- **Google ATC** (`adstransparency.google.com`) renders from
  `POST /anji/_/rpc/SearchService/SearchCreatives` — protobuf-JSON with numeric field keys,
  response shaped `{"1": [creatives…], "2": nextCursor}`.

So the integration is: **the user scrolls, we read what the page already asked for.** We do
not forge requests, do not need tokens, do not need to reverse a signing scheme, and we
inherit the user's own session and rate limits. That is both the most robust option and the
lowest-risk one.

### Concrete work items

1. `detectPlatform()` — add a **path check before the hostname check**. Today
   `facebook.com/ads/library/` returns `'facebook'` and gets run through `extractFacebook()`,
   which will produce empty/garbage rows. Needs `metaads` and `googleads` to win first.
2. `extractSocialRows()` — two new branches, two new `extractMetaAds()` / `extractGoogleAds()`.
3. `net_hook.js` — a `collect()` branch per payload shape (the Instagram one is already the
   template: walk the JSON, key by ad id, merge non-empty values).
4. `manifest.json` — add `*://*.adstransparency.google.com/*` to `host_permissions` and to
   both `content_scripts` match lists; `facebook.com` is already covered for hosts but
   `net_hook.js` currently matches only 4 domains, so ATC must be added there too.
5. **A new column set.** Ads are not posts. `SOCIAL_COLUMNS` does not fit and should not be
   stretched — see the schema below.
6. `STORE_SUBMISSION.txt` — single-purpose description and a justification for the new host.

---

## Schema (proposed `ADS_COLUMNS`)

Shared: `Advertiser`, `Ad ID`, `Ad Copy`, `Headline`, `CTA`, `Landing Page`, `Landing Domain`,
`First Shown`, `Last Shown`, `Days Running`, `Format` (image/video/carousel/text),
`Variants` (how many creatives in the ad), `Platforms` (FB/IG/Audience Network/Messenger, or
Search/YouTube/Display/Shopping/Maps/Play), `Countries`, `Status` (active/inactive),
`Image Text` (our existing on-device OCR), `Offer Type` (the column already queued as
feedback item #5), `URL`, `Thumbnail`.

Meta-only when present: `Spend Range`, `Impressions Range`, `Currency`, `Library ID`,
`Disclaimer` ("Paid for by"). These are **political/issue ads only** — for commercial ads Meta
publishes no spend or impressions anywhere, so those columns will be blank for normal
brand ads. Worth saying plainly in the UI so it doesn't read as a bug.

Google-only: `Advertiser ID`, `Verified Advertiser`, `Region`.

`Days Running` is the one derived field worth computing — it is the closest public proxy for
"this creative is working", since neither platform publishes commercial performance. A long
run plus many variants is the real signal, and it feeds straight into the Top Performers
analysis already queued as feedback item #8.

---

## Meta: what the official API actually gives you

I tested the advertiser-authenticated Ad Library search live while writing this
(`search_terms: "smartphone offer"`, `countries: [IN]`, `ad_type: ALL`):

- **8,226** estimated results — so commercial (non-political) ads *are* returned outside the
  EU on this surface, which contradicts most of what is written online about the public API.
- Fields returned: `id`, `page_id`, `page_name`, `ad_creative_link_title`,
  `ad_creation_time`, `ad_delivery_start_time`, `ad_snapshot_url`, `currency`.
- Fields **not** returned: the ad body copy, the creative image/video, impressions, spend.

The free public `ads_archive` Graph API is narrower: political and social-issue ads globally,
and `ad_type=ALL` (regular product ads) only when `ad_reached_countries` is an EU state or
the UK, because that exists to satisfy the DSA. It needs a Facebook developer app, government
-ID verification, and a token that expires every 60 days.

**Implication:** the official API is a poor fit for this extension. It gives no creative, no
body copy, and no media to OCR — which is the whole value of our product — and it would force
a developer-app + ID-verification onboarding on every user. The in-page route gives us the
rendered ad, the copy, and the image/video we can read text from.

## Google: there is no commercial API

Official programmatic access is two public BigQuery datasets: `google_political_ads` (election
ads, with spend and impressions) and `google_ads_transparency_center` (EEA creative stats
published under the DSA). Neither covers commercial ads outside the EEA, and BigQuery is not
something we can query from an extension without the user bringing GCP credentials.

So for Google the in-page route is the only route.

---

## Risks, stated honestly

**Meta's terms.** Meta's Automated Data Collection Terms (in force since 1 Jan 2025) prohibit
automated collection without prior written permission, and explicitly cover both logged-in and
logged-out access. Meta has sent cease-and-desist letters to operators running heavy crawlers
against the Ad Library at scale. The mitigating facts for us: in *Meta v. Bright Data* a
California court held Meta's terms did not prohibit scraping of **public** data by a party not
logged in; we run at human speed in the user's own browser, triggered by the user's own
scrolling; and we do not host, resell, or aggregate the output. That is a materially different
posture from a commercial crawler — but it is **not zero risk**, and the risk lands on the end
user's account, not on us. My recommendation is that the UI say so in one line.

**Google's internal RPC is undocumented.** Numeric protobuf field keys will be renumbered
without notice. Reading the page's own responses instead of forging requests is the
cheaper-to-maintain side of that, but it will still break periodically. Budget for it.

**Chrome Web Store.** Two things to handle before submitting: the single-purpose description
has to cover ad libraries (it currently describes social posts and product reviews), and the
new host permission needs its own justification line. Neither is a blocker — the extension
still does one thing, in the user's own session, with everything processed on-device — but a
reviewer will ask.

**Sandbox limitation on my side.** I could not reach `adstransparency.google.com` from this
environment (the egress proxy returns 403 on CONNECT), so the ATC endpoint shape above is
from published write-ups, **not verified by me**. Everything in the Meta section I verified
directly. I will not write parsers against an unverified payload shape — see below.

---

## What I need to build this properly

One capture file per platform, from a real logged-in browser. `tools/capture_ads_payloads.js`
in this repo does it: paste it into the DevTools console on each site, scroll a bit, and it
saves a JSON file of the actual responses, with the obvious identifiers stripped.

With those two files I build the parsers against real data and test them in real Chrome the
same way `test_caption_net.js` and `test_extension_e2e.js` already do. Without them I would be
guessing at field shapes — which is exactly how the Duration column shipped broken in v2.10.0.

## Suggested sequencing

The five items still open from the last feedback round (caption auto-fill, Offer Type, the
single-dataset download flow, Top Performers "why", Raw-tab analysis) all improve data we
already collect. Ad libraries add a new data source. I would finish the open five first and
land ads libraries as v2.12 — unless ad-library coverage is the thing you most want to demo,
in which case say so and I will flip the order.
