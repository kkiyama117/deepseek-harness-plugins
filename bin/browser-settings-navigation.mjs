/** Open the existing Settings UI through supported English or Japanese navigation. */
export async function openSettings(page) {
  await page.getByRole('button', { name: /^(New session|New Session|新規セッション)$/ }).first().waitFor({ timeout: 30000 });
  const account = page.getByRole('button', { name: /^(Account menu|アカウントメニュー)$/ });
  const directSettings = page.getByRole('button', { name: /^(Settings|設定)$/ });
  if (await account.isVisible()) {
    await account.click();
    await page.getByRole('menuitem', { name: /^(Settings|設定)/ }).click();
  } else if (await directSettings.isVisible()) {
    await directSettings.click();
  } else {
    await page.getByText(/^(More|その他)$/).last().click();
    await page.getByText(/^(Settings|設定)$/).first().click();
  }
  await page.getByRole('dialog').getByText(/^(General|一般)$/).first().waitFor({ timeout: 15000 });
}
