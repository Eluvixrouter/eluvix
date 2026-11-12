import { test, expect } from '@playwright/test';

test.describe('Eluvix Visual Node Routing Editor & Gateway E2E', () => {
  test('renders sign-in or Eluvix Visual Node Routing Editor and responds on /api/v1/health', async ({
    page,
    request,
  }) => {
    const healthRes = await request.get('/api/v1/health');
    expect([200, 401]).toContain(healthRes.status());

    await page.goto('/editor');
    await expect(page).toHaveTitle(/Eluvix/i);
  });
});
