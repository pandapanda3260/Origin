"""End-to-end check: visit / first, log in via mock API, navigate workspace pages.
Captures fresh screenshots to local-screenshots-final/.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
OUT = ROOT / "local-screenshots-final"
OUT.mkdir(exist_ok=True)
LOCAL = "http://localhost:3000"
CHROME = "/Users/linsen/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"

PAGES = ["overview", "script", "assets", "shots", "images", "prompts",
         "batch", "edit", "library", "profile", "settings", "admin"]


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page = ctx.new_page()
        page.on("pageerror", lambda exc: errors.append(("pageerror", str(exc))))
        page.on("console", lambda m: m.type == "error" and errors.append(("console.error", m.text)))

        print("[1] Landing /")
        page.goto(LOCAL + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "00-landing.png"), full_page=True)

        print("[2] Open login modal & submit (real flow)")
        page.evaluate("openAuthModal && openAuthModal(new Event('click'))")
        page.wait_for_timeout(500)
        page.fill("#m_loginUser", "anyone")
        page.fill("#m_loginPwd", "anything")
        page.click("#m_initBtn")
        page.wait_for_timeout(2500)

        print("[3] Workspace pages")
        page.goto(LOCAL + "/workspace", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        page.screenshot(path=str(OUT / "01-workspace-init.png"), full_page=True)

        for slug in PAGES:
            try:
                # Close any open billing modal first
                page.evaluate("""
                  () => {
                    const m = document.getElementById('billingModal');
                    if (m && m.classList.contains('is-open')) {
                      const btn = document.getElementById('billingModalClose');
                      if (btn) btn.click();
                    }
                  }
                """)
                page.wait_for_timeout(300)
                page.click(f'[data-page="{slug}"]', timeout=3000, force=True)
            except Exception as e:
                print(f"  click[{slug}] failed: {e}")
                continue
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / f"ws-{slug}.png"), full_page=True)
            print(f"    ws-{slug}.png saved")

        browser.close()

    if errors:
        print("\n=== JS errors observed ===")
        for tag, msg in errors[:20]:
            print(f"  [{tag}] {msg[:200]}")
    else:
        print("\nNo JS errors observed!")


if __name__ == "__main__":
    main()
