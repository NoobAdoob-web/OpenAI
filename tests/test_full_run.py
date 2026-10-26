"""Runs the whole daily check (location -> products -> CSV -> email step) on the fake shop."""

from stockwatch import detect
from test_offline import PID_IN, PID_OUT, shop  # noqa: F401  (shop is a pytest fixture)


def test_full_check_run(shop, tmp_path, monkeypatch):
    import run
    from stockwatch import platforms

    base, fake = shop
    monkeypatch.setitem(platforms.PLATFORMS, "fakeshop", type(fake))
    monkeypatch.setattr(run, "RESULTS_DIR", str(tmp_path))
    monkeypatch.delenv("ALERT_TO", raising=False)
    (tmp_path / "products.csv").write_text(
        "platform,product,city,url\n"
        f"fakeshop,Turmeric,Gurgaon,{base}/pn/in/pvid/{PID_IN}\n"
        f"fakeshop,Hing,Gurgaon,{base}/pn/out/pvid/{PID_OUT}\n"
        f"blinkit,Chilli,Gurgaon,https://blinkit.com/prn/x/prid/1\n")
    (tmp_path / "locations.csv").write_text("city,pincode,area,lat,lon\nGurgaon,122002,Cyber City,28.495,77.089\n")
    args = type("Args", (), {"products": str(tmp_path / "products.csv"), "locations": str(tmp_path / "locations.csv"),
                             "limit": 0, "always_email_owners": False})
    assert run.run_check(args) == 0
    latest = (tmp_path / "latest.csv").read_text()
    assert f"{detect.IN_STOCK}" in latest and f"{detect.OUT_OF_STOCK}" in latest
    assert "blinkit is not supported yet" in latest
