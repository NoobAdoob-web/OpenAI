# Quick-Commerce Stock Watch

Every morning at **7:00 AM (India time)** this tool opens each product link you list, once for every
pincode you list, and emails you which products are **out of stock, and where**.

Pilot: **Zepto × 5 Catch products × 5 Gurgaon pincodes** (25 checks a day).

```
data/products.csv   ← the product links to watch          (edit this)
data/locations.csv  ← the pincodes to check them in        (edit this)
results/latest.csv  ← this morning's results (updated automatically)
results/history.csv ← every day's results, for trends     (updated automatically)
```

---

## One-time setup (about 15 minutes, no coding)

### 1. Make this repository private
GitHub → this repository → **Settings** → **General** → scroll to **Danger Zone** →
**Change visibility** → **Private**.

Private repositories get 2,000 free automation minutes a month. The pilot uses roughly 10 minutes a day.

### 2. Get an email "app password" for the sending account
The report is sent **from** a Gmail account (a shared team Gmail is ideal) **to** anyone you choose.

1. Sign in to the sending Gmail account.
2. Turn on 2-Step Verification: <https://myaccount.google.com/security>
3. Create an app password: <https://myaccount.google.com/apppasswords> (name it "stock watch").
   Google shows a 16-letter password. Copy it.

### 3. Store the email settings as hidden "secrets"
GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
Add these three:

| Name | Value |
|---|---|
| `SMTP_USER` | the sending Gmail address, e.g. `stockwatch.team@gmail.com` |
| `SMTP_PASSWORD` | the 16-letter app password from step 2 |
| `ALERT_TO` | who gets the report. Separate several addresses with commas |

Secrets are never shown in the code or the logs.

### 4. Run it once now
GitHub → **Actions** tab → **Daily stock check** → **Run workflow** → **Run workflow**.
In about 10 minutes you should get the email. From then on it runs by itself every morning.

---

## Everyday use

### Add or remove products
Open `data/products.csv` → click the ✏️ pencil → add a line → **Commit changes**.

```
platform,product,city,url
zepto,Catch Turmeric Powder 100g,Gurgaon,https://www.zepto.com/pn/...
```

- `product` is the name shown in the email (your choice).
- `city` must match a city in `data/locations.csv`. Each product is checked in **every pincode of its city**.
- Optional `owner_email` column: that team member also gets an email with **only their products**, on days
  when one of them is out of stock. Separate several people with `;`.

### Add or remove pincodes
Edit `data/locations.csv` the same way. `lat`/`lon` are the map position used as the "delivery address".
Leave them blank and the tool looks the pincode up on OpenStreetMap automatically.

### Find every product of a brand ("what links exist for Catch?")
**Actions** → **Find all products for a brand** → **Run workflow** → type the search (e.g. `catch`) and a pincode.
You get an email listing every matching product with its link, pack size, price and stock. The list is also
saved as a file you can download from the run page (**Artifacts**), in the same columns as `products.csv`,
so rows can be copied straight in.

### Reading the email

| Icon | Meaning |
|---|---|
| ✅ | In stock |
| ❌ | Out of stock |
| 🚫 | The platform doesn't deliver to this pincode |
| ⚠️ | The website blocked the checker |
| ❓ | The checker couldn't tell. A screenshot is saved in the run's **Artifacts** |

The bottom of the email shows which delivery location the website actually displayed for each pincode,
so you can confirm it really checked the right area.

---

## Good to know

- **Zepto only for now.** Blinkit, Instamart, Flipkart Minutes and Amazon will be added one at a time once
  Zepto is reliable. Each site needs its own small adaptation.
- **Stock is per dark store.** Location is set by giving the browser the pincode's map position
  (like a phone's GPS), the same as a shopper tapping "Use my current location".
- **If Zepto blocks the checker** (⚠️ in the email), the tool reports it and stops for that pincode. It does
  not try to get around the block. In that case the right route is a licensed data source, such as the
  platform's own brand/seller availability reports or a paid data provider.
- **Website redesigns can break the check.** When ❓ starts appearing everywhere, the page layout has
  probably changed and the tool needs a small update.
- This tool only reads public product pages, at a low rate (one page at a time, once a day). Make sure
  your use complies with each platform's terms.

---

## For developers

```bash
pip install -r requirements.txt
python -m playwright install chromium
python -m pytest tests            # offline tests against a fake shop, no internet needed
python run.py check --limit 2     # real check of the first 2 products (emails only if secrets are set)
python run.py discover --query catch --pincode 122002
```

Code layout: `stockwatch/platforms/` has one file per site (location + product-id rules), `stockwatch/detect.py`
decides in stock / out of stock, and `stockwatch/report.py` builds the email and CSV files.
