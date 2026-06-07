"""Capture logged-in screenshots and DOM snapshots from QD INFINITY.

Usage: python3 capture.py
Creates: ./screenshots/<page>.png and ./dom/<page>.html for each workspace page.
"""

import os
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
SHOTS = ROOT / "screenshots"
DOM = ROOT / "dom"
SHOTS.mkdir(exist_ok=True)
DOM.mkdir(exist_ok=True)

PHONE = os.environ.get("ORIGIN_CAPTURE_PHONE", "19900000000")
PASSWORD = os.environ.get("ORIGIN_CAPTURE_PASSWORD", "change-me")
BASE = "https://inf.apiqd.com"

PAGES = [
    "overview", "script", "assets", "shots", "images",
    "prompts", "batch", "edit", "library", "profile",
    "settings", "billing", "admin",
]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/Users/linsen/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell")
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=2,
        )
        page = context.new_page()

        print("[1] Open homepage")
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(SHOTS / "00-landing.png"), full_page=True)
        (DOM / "00-landing.html").write_text(page.content(), encoding="utf-8")

        print("[2] Open login modal")
        try:
            page.click("text=登录 / 注册", timeout=5000)
        except Exception:
            page.evaluate("openAuthModal && openAuthModal(new Event('click'))")
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "01-login-modal.png"), full_page=True)

        print("[3] Fill credentials via JS API")
        api_resp = page.evaluate(
            """async ({phone,p}) => {
                const resp = await fetch('/api/auth/login', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({phone, password:p})
                });
                const data = await resp.json();
                if (resp.ok && data && data.token) {
                    localStorage.setItem('sw_auth_token', data.token);
                    localStorage.setItem('sw_auth_user', JSON.stringify(data.user));
                    return {ok:true, status:resp.status, hasToken:!!data.token};
                }
                return {ok:false, status:resp.status, body:data};
            }""",
            {"phone": PHONE, "p": PASSWORD},
        )
        print("    login result:", api_resp)
        page.screenshot(path=str(SHOTS / "02-login-filled.png"), full_page=True)

        print("[4] Wait & screenshot post-login")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "03-after-login.png"), full_page=True)

        print("[5] Goto workspace")
        page.goto(BASE + "/workspace", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)
        page.screenshot(path=str(SHOTS / "04-workspace-loaded.png"), full_page=True)
        # also dump localStorage / cookies for debugging
        ls = page.evaluate("() => ({token: localStorage.getItem('sw_auth_token'), user: localStorage.getItem('sw_auth_user')})")
        print("    workspace localStorage:", ls)

        for slug in PAGES:
            print(f"[6] Capture page: {slug}")
            try:
                page.click(f'[data-page="{slug}"]', timeout=3000)
            except Exception:
                try:
                    btn = f'#nav{slug.capitalize()}'
                    page.click(btn, timeout=3000)
                except Exception:
                    pass
            page.wait_for_timeout(1800)
            page.screenshot(path=str(SHOTS / f"ws-{slug}.png"), full_page=True)
            (DOM / f"ws-{slug}.html").write_text(page.content(), encoding="utf-8")

        # also: open task center
        try:
            page.click("text=任务中心", timeout=3000)
            page.wait_for_timeout(800)
            page.screenshot(path=str(SHOTS / "ws-tasks-drawer.png"), full_page=True)
        except Exception:
            pass

        # also: open billing modal
        try:
            page.click("#navBilling", timeout=3000)
            page.wait_for_timeout(800)
            page.screenshot(path=str(SHOTS / "ws-billing-modal.png"), full_page=True)
        except Exception:
            pass

        browser.close()
        print("Done. Output in", SHOTS, "and", DOM)


if __name__ == "__main__":
    main()
