const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/browser');
const { getCurrentUser } = require('./helpers/api');
const { TEST_USERS } = require('./constants/users');

// Regression coverage for 08dcd65 / PR #87. Fixtures never use the bank mock,
// whose global sync state is shared with parallel workflows.
const PAYMENT = 870001;
const TRANSACTION = 870001;
const HIDDEN_USER = 5987;
const MARKER = 'playwright-finance-auth-87';
const HTML = '</textarea><img data-auth87 src=x onerror="window.auth87=true">';
let db;
let owner;

async function cleanup() {
  await db.execute('DELETE FROM tst_claim WHERE payment_id = ?', [PAYMENT]);
  await db.execute('DELETE FROM tst_finance WHERE id = ? OR note LIKE ?', [PAYMENT, `Banka: VS 8787 ${MARKER}%`]);
  await db.execute('DELETE FROM tst_bank_transactions WHERE id = ?', [TRANSACTION]);
  await db.execute('DELETE FROM tst_users WHERE id = ? AND sort_name = ?', [HIDDEN_USER, MARKER]);
}

async function claims() {
  const [rows] = await db.execute('SELECT user_id, text FROM tst_claim WHERE payment_id = ? ORDER BY id', [PAYMENT]);
  const [[payment]] = await db.execute('SELECT claim FROM tst_finance WHERE id = ?', [PAYMENT]);
  return { rows, claim: payment.claim };
}

async function bankState() {
  const [[row]] = await db.execute('SELECT status, finance_id FROM tst_bank_transactions WHERE id = ?', [TRANSACTION]);
  const [payments] = await db.execute('SELECT id FROM tst_finance WHERE note LIKE ?', [`Banka: VS 8787 ${MARKER}%`]);
  return { ...row, payments };
}

async function denied(response) {
  expect(response.status()).toBe(302);
  expect(response.headers().location).toContain('error.php?code=21');
}

const claimUrl = `./claim.php?payment_id=${PAYMENT}`;
const bankUrl = `./fin_bank_orphan_assign.php?tx_id=${TRANSACTION}`;

test.describe('Payment claim and orphan assignment authorization', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    // Use the same local dev/autotest database as PHP, with optional remote-run overrides.
    const config = fs.readFileSync(path.join(__dirname, '../../www/cfg/_cfg.php'), 'utf8');
    const setting = (name) => config.match(new RegExp(`\\$${name}\\s*=\\s*['"]([^'"]*)['"]`))?.[1];
    db = await mysql.createConnection({
      host: process.env.PLAYWRIGHT_DB_HOST || setting('g_dbserver'),
      port: Number(process.env.PLAYWRIGHT_DB_PORT || setting('g_dbport') || 3306),
      user: process.env.PLAYWRIGHT_DB_USER || setting('g_dbuser'),
      password: process.env.PLAYWRIGHT_DB_PASSWORD || setting('g_dbpass'),
      database: process.env.PLAYWRIGHT_DB_NAME || setting('g_dbname'),
    });
    owner = await getCurrentUser(browser, TEST_USERS.member);
    expect(owner.user_id).toBeGreaterThan(0);
    await cleanup();
    await db.execute('INSERT INTO tst_users (id, sort_name, hidden, mesto, psc, rc) VALUES (?, ?, 1, ?, ?, ?)',
      [HIDDEN_USER, MARKER, '', '', '']);
  });

  test.beforeEach(async () => {
    await db.execute('DELETE FROM tst_claim WHERE payment_id = ?', [PAYMENT]);
    await db.execute('DELETE FROM tst_finance WHERE id = ? OR note LIKE ?', [PAYMENT, `Banka: VS 8787 ${MARKER}%`]);
    await db.execute('INSERT INTO tst_finance (id, id_users_editor, id_users_user, amount, date, note, claim) VALUES (?, ?, ?, 0, CURRENT_DATE, ?, 1)',
      [PAYMENT, owner.user_id, owner.user_id, HTML]);
    await db.execute('INSERT INTO tst_claim (user_id, payment_id, text, date) VALUES (?, ?, ?, CURRENT_TIMESTAMP - INTERVAL 1 DAY)', [owner.user_id, PAYMENT, HTML]);
    await db.execute('DELETE FROM tst_bank_transactions WHERE id = ?', [TRANSACTION]);
    await db.execute('INSERT INTO tst_bank_transactions (id, transaction_id, amount, currency, variable_symbol, originator_message) VALUES (?, ?, 0, ?, ?, ?)',
      [TRANSACTION, MARKER, 'CZK', '8787', `${MARKER}${HTML}`]);
  });

  test.afterAll(async () => {
    if (db) {
      try { await cleanup(); } finally { await db.end(); }
    }
  });

  for (const role of ['anonymous', 'smallManager']) {
    test(`${role} cannot read or mutate another member's claim or assign an orphan`, async ({ page }) => {
      if (role !== 'anonymous') await loginAs(page, role);
      const beforeClaims = await claims();
      const beforeBank = await bankState();
      for (const url of [claimUrl, bankUrl]) {
        await denied(await page.request.get(url, { maxRedirects: 0 }));
      }
      for (const action of ['submit', 'close']) {
        await denied(await page.request.post(claimUrl, {
          form: { [action]: '1', claim_text: 'unauthorized' }, maxRedirects: 0,
        }));
      }
      await denied(await page.request.post(bankUrl, {
        form: { submit: '1', assign_user_id: String(owner.user_id) }, maxRedirects: 0,
      }));
      expect(await claims()).toEqual(beforeClaims);
      expect(await bankState()).toEqual(beforeBank);
    });
  }

  test('payment owner can edit and close their claim but cannot assign an orphan', async ({ page }) => {
    await loginAs(page, 'member');
    await page.goto(claimUrl);
    await expect(page.locator('#claim_text')).toHaveValue(HTML);
    await expect(page.locator('.claim-history-text')).toHaveText(HTML);
    await expect(page.locator('body')).toContainText(HTML);
    await expect(page.locator('[data-auth87]')).toHaveCount(0);
    expect(await page.evaluate(() => window.auth87)).toBeUndefined();
    await page.request.post(claimUrl, { form: { submit: '1', claim_text: 'owner edit' } });
    expect((await claims()).rows).toEqual([{ user_id: owner.user_id, text: 'owner edit' }]);
    await page.request.post(claimUrl, { form: { close: '1' } });
    expect((await claims()).claim).toBe(0);
    await denied(await page.request.get(bankUrl, { maxRedirects: 0 }));
    await denied(await page.request.post(bankUrl, {
      form: { submit: '1', assign_user_id: String(owner.user_id) }, maxRedirects: 0,
    }));
    expect((await bankState()).status).toBe('ORPHAN');
    expect((await bankState()).payments).toEqual([]);
  });

  test('finance user can respond to and close another member\'s claim', async ({ page }) => {
    await loginAs(page, 'accountant');
    await page.goto(claimUrl);
    await expect(page.locator('#claim_text')).toHaveValue('');
    await page.request.post(claimUrl, { form: { submit: '1', claim_text: HTML } });
    const state = await claims();
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1].user_id).not.toBe(owner.user_id);
    expect(state.rows[1].text).toBe(HTML);
    await page.goto(claimUrl);
    await expect(page.locator('#claim_text')).toHaveValue(HTML);
    await expect(page.locator('[data-auth87]')).toHaveCount(0);
    await page.request.post(claimUrl, { form: { close: '1' } });
    expect((await claims()).claim).toBe(0);
  });

  test('GET parameters cannot edit or close claims or assign payments', async ({ page }) => {
    await loginAs(page, 'accountant');
    const before = await claims();
    for (const action of ['submit', 'close']) {
      await page.request.get(`${claimUrl}&${action}=1&claim_text=GET-change`);
      expect(await claims()).toEqual(before);
    }
    const bank = await bankState();
    await page.request.get(`${bankUrl}&submit=1&assign_user_id=${owner.user_id}`);
    expect(await bankState()).toEqual(bank);
  });

  test('finance user rejects invalid targets, escapes bank details, and assigns only once', async ({ page }) => {
    await loginAs(page, 'accountant');
    await page.goto(bankUrl);
    await expect(page.locator('body')).toContainText(`${MARKER}${HTML}`);
    await expect(page.locator('[data-auth87]')).toHaveCount(0);
    const before = await bankState();
    for (const target of ['0', '-1', 'invalid', '65535', String(HIDDEN_USER)]) {
      await denied(await page.request.post(bankUrl, {
        form: { submit: '1', assign_user_id: target }, maxRedirects: 0,
      }));
      expect(await bankState()).toEqual(before);
    }
    await page.request.post(bankUrl, { form: { submit: '1', assign_user_id: String(owner.user_id) } });
    const assigned = await bankState();
    expect(assigned.status).toBe('PROCESSED');
    expect(assigned.payments).toEqual([{ id: assigned.finance_id }]);
    await page.request.post(bankUrl, { form: { submit: '1', assign_user_id: String(owner.user_id) } });
    expect(await bankState()).toEqual(assigned);
  });

  test('missing or malformed payments are denied even to finance users', async ({ page }) => {
    await loginAs(page, 'accountant');
    for (const payment of ['0', '-1', 'invalid']) {
      const url = `./claim.php?payment_id=${payment}`;
      await denied(await page.request.get(url, { maxRedirects: 0 }));
      await denied(await page.request.post(url, { form: { submit: '1', claim_text: 'invalid' }, maxRedirects: 0 }));
    }
  });
});
