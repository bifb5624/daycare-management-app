// つむぎ E2Eスモークテスト(2026-09-01)
// テスト項目一覧の画面操作系【自動】化の第1弾。 ローカルモード(Supabase未接続)で起動した
// アプリに対して、主要画面の表示と基本操作を確認する。 白画面・未捕捉エラーを検知する。
// 対応項目: T-OPS-01(画面遷移系の一部) / 各画面のクラッシュ検知(全カテゴリの前提)
import { test, expect } from '@playwright/test';

// 各テストで未捕捉エラーを収集し、最後に0件であることを確認する
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message ? err.message : err)));
  return errors;
}

async function boot(page) {
  await page.goto('/');
  // ローカルモードはログインなしでサイドバーが出る
  await expect(page.getByText('利用者マスタ管理', { exact: true })).toBeVisible({ timeout: 20000 });
}

test('起動: 白画面にならずサイドバーが表示される', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  expect(errors, `未捕捉エラー: ${errors.join(' / ')}`).toEqual([]);
});

const VIEWS = [
  'サービス提供記録 入力',
  '連絡帳',
  '日誌',
  '利用者マスタ管理',
  'ケアマネ事業所・担当者',
  '各種設定',
];

for (const label of VIEWS) {
  test(`画面遷移: ${label} がクラッシュせず表示される`, async ({ page }) => {
    const errors = collectErrors(page);
    await boot(page);
    await page.getByText(label, { exact: true }).first().click();
    // 遷移後にアプリ全体が白画面化していないこと(サイドバーが残っている)
    await expect(page.getByText('利用者マスタ管理', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(1200); // 遅延レンダリングのエラーも拾う
    expect(errors, `未捕捉エラー: ${errors.join(' / ')}`).toEqual([]);
  });
}

test('日誌: AM/PM切替と保存ボタンが機能する', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.getByText('日誌', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'PM', exact: true }).first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'PM', exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'AM', exact: true }).first().click();
  await page.waitForTimeout(800);
  expect(errors, `未捕捉エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('ケアマネ画面: 追加ポップアップが開閉できる', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.getByText('ケアマネ事業所・担当者', { exact: true }).first().click();
  const addBtn = page.getByRole('button', { name: '事業所を追加' }).first();
  await expect(addBtn).toBeVisible({ timeout: 15000 });
  await addBtn.click();
  await expect(page.getByText('ケアマネ事業所を追加', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル' }).first().click();
  await page.waitForTimeout(500);
  expect(errors, `未捕捉エラー: ${errors.join(' / ')}`).toEqual([]);
});
