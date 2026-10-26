"""Turns the check results into CSV files and the morning email."""

import csv
import html
import os
import smtplib
from collections import OrderedDict
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from . import detect

FIELDS = ["date", "platform", "product", "city", "pincode", "area", "status", "note", "title_on_page", "url"]
ICON = {detect.IN_STOCK: "✅", detect.OUT_OF_STOCK: "❌", detect.NOT_SERVICEABLE: "🚫",
        detect.BLOCKED: "⚠️", detect.UNKNOWN: "❓"}


def write_csvs(rows, results_dir):
    os.makedirs(results_dir, exist_ok=True)
    latest = os.path.join(results_dir, "latest.csv")
    with open(latest, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    history = os.path.join(results_dir, "history.csv")
    new = not os.path.exists(history)
    with open(history, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        w.writerows(rows)
    return latest


def subject(rows, date):
    oos = sum(r["status"] == detect.OUT_OF_STOCK for r in rows)
    unclear = sum(r["status"] in (detect.UNKNOWN, detect.BLOCKED) for r in rows)
    cities = ", ".join(sorted({r["city"] for r in rows if r["city"]}))
    if oos:
        head = f"{oos} out of stock"
    elif unclear == len(rows):
        head = "check could not run properly"
    else:
        head = "all in stock"
    return f"Stock check {date} ({cities}): {head}" + (f", {unclear} unclear" if unclear and oos else "")


def build_email(rows, date, locations_seen):
    pincodes = list(OrderedDict.fromkeys((r["pincode"], r["area"]) for r in rows))
    products = list(OrderedDict.fromkeys((r["platform"], r["product"], r["url"]) for r in rows))
    by_key = {(r["url"], r["pincode"]): r for r in rows}
    total = len(rows)
    count = lambda s: sum(r["status"] == s for r in rows)

    out = [f"<p style='font-size:15px'><b>{count(detect.OUT_OF_STOCK)}</b> out of stock · "
           f"<b>{count(detect.IN_STOCK)}</b> in stock · "
           f"<b>{total - count(detect.OUT_OF_STOCK) - count(detect.IN_STOCK)}</b> need attention "
           f"<span style='color:#666'>({len(products)} products × {len(pincodes)} pincodes)</span></p>"]

    oos_rows = []
    for platform, name, url in products:
        missing = [f"{pin} ({area})" if area else pin for pin, area in pincodes
                   if by_key.get((url, pin), {}).get("status") == detect.OUT_OF_STOCK]
        if missing:
            oos_rows.append(f"<tr><td><a href='{html.escape(url)}'>{html.escape(name)}</a></td>"
                            f"<td>{platform.title()}</td><td>{len(missing)} of {len(pincodes)}</td>"
                            f"<td>{html.escape(', '.join(missing))}</td></tr>")
    if oos_rows:
        out.append("<h3 style='color:#b00020'>❌ Out of stock</h3>"
                   "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse'>"
                   "<tr style='background:#f3f3f3'><th>Product</th><th>Platform</th><th>Pincodes</th><th>Where</th></tr>"
                   + "".join(oos_rows) + "</table>")

    head = "".join(f"<th title='{html.escape(area)}'>{pin}<br><span style='font-weight:normal;font-size:11px'>"
                   f"{html.escape(area)}</span></th>" for pin, area in pincodes)
    grid = []
    for platform, name, url in products:
        cells = "".join(f"<td align='center' title='{html.escape(by_key.get((url, pin), {}).get('note', ''))}'>"
                        f"{ICON.get(by_key.get((url, pin), {}).get('status'), '')}</td>" for pin, _ in pincodes)
        grid.append(f"<tr><td><a href='{html.escape(url)}'>{html.escape(name)}</a> "
                    f"<span style='color:#666'>({platform.title()})</span></td>{cells}</tr>")
    out.append("<h3>Full picture</h3>"
               "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse;font-size:13px'>"
               f"<tr style='background:#f3f3f3'><th>Product</th>{head}</tr>" + "".join(grid) + "</table>"
               "<p style='font-size:12px;color:#666'>✅ in stock · ❌ out of stock · 🚫 platform not delivering "
               "to this pincode · ⚠️ site blocked the checker · ❓ could not tell</p>")

    attention = [r for r in rows if r["status"] not in (detect.IN_STOCK, detect.OUT_OF_STOCK)]
    if attention:
        items = "".join(f"<li>{html.escape(r['product'])} @ {r['pincode']}: "
                        f"{detect.LABELS[r['status']]}{(' - ' + html.escape(r['note'])) if r['note'] else ''}</li>"
                        for r in attention[:40])
        out.append(f"<h3>Needs attention</h3><ul style='font-size:13px'>{items}</ul>")

    if locations_seen:
        items = "".join(f"<li>{html.escape(k)}: <i>{html.escape(v)}</i></li>" for k, v in locations_seen.items())
        out.append("<h3 style='font-size:13px'>Delivery location the site showed</h3>"
                   f"<ul style='font-size:12px;color:#555'>{items}</ul>")
    return "<div style='font-family:Arial,sans-serif'>" + "".join(out) + "</div>"


def send_email(subject_line, html_body, recipients):
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "").replace(" ", "")
    sender = os.environ.get("EMAIL_FROM") or user
    recipients = [r.strip() for r in recipients if r and r.strip()]
    if not (user and password and recipients):
        print("i Email not sent: SMTP_USER / SMTP_PASSWORD / ALERT_TO secrets are not set yet.")
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"], msg["From"], msg["To"] = subject_line, sender, ", ".join(recipients)
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=30)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
        server.starttls()
    with server:
        server.login(user, password)
        server.sendmail(sender, recipients, msg.as_string())
    print(f"✓ Email sent to {', '.join(recipients)}")
    return True
