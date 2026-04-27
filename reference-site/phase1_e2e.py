"""Phase 1 e2e: real auth + project persistence in browser."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
OUT = ROOT / "phase1-screenshots"
OUT.mkdir(exist_ok=True)
LOCAL = "http://localhost:3000"
CHROME = "/Users/linsen/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page = ctx.new_page()
        page.on("pageerror", lambda exc: errors.append(("pageerror", str(exc))))
        page.on("console", lambda m: m.type == "error" and errors.append(("console.error", m.text)))

        print("[1] Visit /workspace WITHOUT auth — should redirect to / with auth modal")
        page.goto(LOCAL + "/workspace", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
        cur_url = page.url
        print(f"    redirected to: {cur_url}")
        page.screenshot(path=str(OUT / "01-redirect-to-login.png"), full_page=True)

        print("[2] Login with seed account pokerman/joker0606")
        page.evaluate("openAuthModal && openAuthModal(new Event('click'))")
        page.wait_for_timeout(500)
        page.fill("#m_loginUser", "pokerman")
        page.fill("#m_loginPwd", "joker0606")
        page.click("#m_initBtn")
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "02-after-login.png"), full_page=True)
        print(f"    after login URL: {page.url}")

        print("[3] Open workspace — should see existing project from earlier API tests")
        if "/workspace" not in page.url:
            page.goto(LOCAL + "/workspace", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)
        page.screenshot(path=str(OUT / "03-workspace-overview.png"), full_page=True)

        print("[4] Logout (clear localStorage) and visit /workspace — should bounce again")
        page.evaluate("() => { localStorage.removeItem('sw_auth_token'); localStorage.removeItem('sw_auth_user'); }")
        page.goto(LOCAL + "/workspace", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "04-after-logout.png"), full_page=True)
        print(f"    final URL after logout-bounce: {page.url}")

        browser.close()

    if errors:
        print(f"\n=== {len(errors)} JS issues observed ===")
        for tag, msg in errors[:10]:
            print(f"  [{tag}] {msg[:200]}")
    else:
        print("\nNo JS errors!")


if __name__ == "__main__":
    main()
