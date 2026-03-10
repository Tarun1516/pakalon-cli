# Webapp Testing Skill

Write, run, and interpret browser-based tests for web applications using Playwright and the Agent Browser.

## Core Capabilities

- **End-to-end tests**: Full user-journey tests from page load to final assertion.
- **Component tests**: Isolated UI component testing via Playwright component harness.
- **Visual regression**: Screenshot-diff tests comparing against approved baselines.
- **Accessibility audits**: Automated a11y checks with axe-core via Playwright.
- **Network mocking**: Intercept and mock API responses for deterministic testing.
- **Performance**: Capture Web Vitals (LCP, CLS, FID) and assert thresholds.
- **Agent Browser TDD loop**: Use `@vercel/agent-browser` snapshot → code → snapshot cycle.

## Test Framework: Playwright (TypeScript)

```typescript
// tests/e2e/auth.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("user can sign in with valid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("user@example.com");
    await page.getByLabel("Password").fill("secret123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("wrong@example.com");
    await page.getByLabel("Password").fill("wrongpass");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid credentials");
  });
});
```

## playwright.config.ts

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { outputFolder: "test-evidence/playwright-report" }]],
  use: {
    baseURL: process.env.APP_BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
```

## Visual Regression Test

```typescript
test("hero section matches approved design", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Screenshot against stored baseline — fails if diff > threshold
  await expect(page.locator(".hero-section")).toHaveScreenshot("hero.png", {
    threshold: 0.05,      // 5% pixel tolerance
    animations: "disabled",
  });
});
```

## Accessibility Audit with axe-core

```typescript
import AxeBuilder from "@axe-core/playwright";

test("homepage has no critical a11y violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations.filter(v => v.impact === "critical")).toHaveLength(0);
});
```

## Network Mocking

```typescript
test("displays products from API", async ({ page }) => {
  await page.route("**/api/products", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: 1, name: "Widget", price: 9.99 }]),
    })
  );
  await page.goto("/products");
  await expect(page.getByText("Widget")).toBeVisible();
});
```

## Python Agent Browser TDD Loop

```python
from agents.phase3.agent_browser import AgentBrowser, run_tdd_loop

async def validate_app(project_dir: str, app_url: str, wireframe_png: str) -> dict:
    result = await run_tdd_loop(
        target_url=app_url,
        wireframe_screenshot=wireframe_png,
        project_dir=project_dir,
        max_iterations=2,
    )
    return result
```

## Test Generation from Design Spec

When generating tests from a `design.md` or wireframe, follow this strategy:

1. **Happy path**: One test per major user story that asserts the full flow succeeds.
2. **Error states**: One test per expected error (empty form, server error, invalid input).
3. **Visual**: One snapshot test per distinct page / major component.
4. **Accessibility**: One `axe-core` test per route.
5. **Edge cases**: Test boundary values (0 items, max-length strings, RTL text).

## Test Naming Convention

```
{page/feature} {user action or condition} {expected outcome}
e.g. "checkout page user submits empty cart shows validation error"
```

## Best Practices

- Prefer role-based locators (`getByRole`, `getByLabel`) over CSS selectors.
- Use `page.waitForLoadState("networkidle")` before visual snapshots.
- Store screenshots in `test-evidence/` — never in `src/`.
- Mock all external APIs in tests — never hit production endpoints.
- Run tests in CI with `--reporter=github` for inline annotation on PRs.
- Keep each test independent — no shared state, no ordering dependencies.
- Set `timeout: 10_000` for slow actions (form submissions, navigation).
