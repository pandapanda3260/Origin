"""Capture our local clone for visual comparison against original screenshots."""

from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
LOCAL_SHOTS = ROOT / "local-screenshots"
LOCAL_SHOTS.mkdir(exist_ok=True)

LOCAL = "http://localhost:3000"
CHROME = "/Users/linsen/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"

PAGES = [
    "overview", "script", "assets", "shots", "images",
    "prompts", "batch", "edit", "library", "profile",
    "settings", "billing", "admin",
]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page = context.new_page()

        page.on("pageerror", lambda exc: print(f"  [pageerror] {exc}"))
        page.on("console", lambda msg: msg.type in ("error", "warning") and print(f"  [console.{msg.type}] {msg.text}"))

        print("[1] Local landing /")
        page.goto(LOCAL + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(LOCAL_SHOTS / "00-landing.png"), full_page=True)

        print("[2] Local /workspace (auto-mock auth)")
        page.goto(LOCAL + "/workspace", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        page.screenshot(path=str(LOCAL_SHOTS / "04-workspace-loaded.png"), full_page=True)

        for slug in PAGES:
            print(f"[3] Capture page: {slug}")
            try:
                page.click(f'[data-page="{slug}"]', timeout=3000)
            except Exception as e:
                print(f"  click failed: {e}")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(LOCAL_SHOTS / f"ws-{slug}.png"), full_page=True)

        browser.close()
        print("Done. Output in", LOCAL_SHOTS)


if __name__ == "__main__":
    main()
