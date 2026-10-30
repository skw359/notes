import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  dumpIndexedDb,
  editor,
  loginViaUi,
  newNote,
  signupViaUi,
  newDevice,
  sql,
  uniqueEmail,
  unlockViaUi,
  verifyBrowserDerivation,
  waitSaved,
} from './helpers.js'

test('signup: the recovery key cannot be dismissed by accident (CRYPTO-4)', async ({ page }) => {
  await page.goto('/signup')
  await page.getByLabel('Email').fill(uniqueEmail('modal'))
  await page.getByLabel('First Name').fill('A')
  await page.getByLabel('Last Name').fill('B')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign Up' }).click()

  const key = page.getByTestId('recovery-key')
  await expect(key).toBeVisible()
  // Backdrop click and Escape no longer close it.
  await page.mouse.click(5, 5)
  await page.keyboard.press('Escape')
  await expect(key).toBeVisible()
  const continueButton = page.getByRole('button', { name: 'I saved it, continue' })
  await expect(continueButton).toBeDisabled()
  await page.getByLabel('I saved this recovery key somewhere safe').check()
  await page.getByLabel('Type the last 4 characters of the key').fill('xxxx')
  await expect(continueButton).toBeDisabled()
})

test('notes are stored only as ciphertext, on the server and in IndexedDB', async ({ page }) => {
  const email = uniqueEmail('plain')
  await signupViaUi(page, { email, first: 'Grace', last: 'Hopper' })
  // The browser's Argon2id matches the native reference implementation.
  expect((await verifyBrowserDerivation(email)).matches).toBe(true)

  await newNote(page)
  const secret = `UNIQUE-PLAINTEXT-${Date.now()}`
  await page.keyboard.type(`Title line\n${secret}`)
  await waitSaved(page)

  const user = (await sql('SELECT * FROM users WHERE email = $1', [email]))[0]
  const rows = [
    user,
    ...(await sql('SELECT * FROM notes WHERE user_id = $1', [user.id])),
    ...(await sql('SELECT * FROM note_revisions WHERE user_id = $1', [user.id])),
  ]
  const serverData = JSON.stringify(rows)
  expect(serverData).not.toContain(secret)
  expect(serverData).not.toContain('Grace')
  expect(serverData).not.toContain('Hopper')

  const local = await dumpIndexedDb(page)
  expect(local.length).toBeGreaterThan(10)
  expect(local).not.toContain(secret)
  expect(local).not.toContain('Title line')

  // Reload: the vault locks; unlocking shows the note again.
  await page.reload()
  await unlockViaUi(page)
  await expect(editor(page)).toContainText(secret)
})

test('two devices: a stale edit becomes a visible conflict, and "keep both" keeps both (DATA-3)', async ({ browser }) => {
  const email = uniqueEmail('conflict')
  const { page: laptop } = await newDevice(browser)
  await signupViaUi(laptop, { email })
  await newNote(laptop)
  await laptop.keyboard.type('Shopping list')
  await waitSaved(laptop)

  const { context: phoneContext, page: phone } = await newDevice(browser)
  await loginViaUi(phone, { email })
  await expect(editor(phone)).toContainText('Shopping list')
  await editor(phone).click()
  await phone.keyboard.press('End')
  await phone.keyboard.type(' - milk, eggs, PHONE EDIT')
  await waitSaved(phone)

  // The laptop has not refreshed yet and types on the stale version.
  await editor(laptop).click()
  await laptop.keyboard.press('End')
  await laptop.keyboard.type('!')
  await expect(laptop.getByText('This note was changed on another device while you were editing it.')).toBeVisible()
  await expect(laptop.locator('.save-status')).toContainText('Changed elsewhere')

  await laptop.getByRole('button', { name: 'Keep both' }).click()
  await expect(laptop.getByText('Your version was saved as a new note')).toBeVisible()

  const user = (await sql('SELECT id FROM users WHERE email = $1', [email]))[0]
  await expect.poll(async () => (await sql('SELECT COUNT(*)::int AS c FROM notes WHERE user_id = $1 AND revision > 0', [user.id]))[0].c).toBe(2)
  await laptop.reload()
  await unlockViaUi(laptop)
  await expect(laptop.locator('.note-item')).toHaveCount(2)
  const titles = await laptop.locator('.note-item-title').allTextContents()
  expect(titles.join('|')).toContain('PHONE EDIT')
  expect(titles.join('|')).toContain('Shopping list!')
  await phoneContext.close()
})

test('session expiry while typing keeps the text and resumes after signing in (DATA-2)', async ({ browser }) => {
  const email = uniqueEmail('expiry')
  const { page } = await newDevice(browser)
  await signupViaUi(page, { email })
  await newNote(page)
  await page.keyboard.type('Before expiry')
  await waitSaved(page)

  // Another device signs out every other session.
  const { context: otherContext, page: other } = await newDevice(browser)
  await loginViaUi(other, { email })
  await expect(other.getByTitle('New Note')).toBeVisible()
  await other.evaluate(() => fetch('/api/auth/sessions/revoke-others', { method: 'POST' }))

  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and after')
  await expect(page.getByText('Your session expired. Your changes are kept on this device.')).toBeVisible()
  await expect(editor(page)).toContainText('Before expiry and after')

  await page.getByPlaceholder('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await waitSaved(page)
  const user = (await sql('SELECT id FROM users WHERE email = $1', [email]))[0]
  const revision = (await sql('SELECT MAX(revision)::int AS r FROM notes WHERE user_id = $1', [user.id]))[0].r
  expect(revision).toBeGreaterThanOrEqual(2)
  await otherContext.close()
})

test('offline edits are kept and sent when the connection returns (DATA-2)', async ({ browser }) => {
  const { context, page } = await newDevice(browser)
  await signupViaUi(page, { email: uniqueEmail('offline') })
  await newNote(page)
  await page.keyboard.type('Online text')
  await waitSaved(page)

  await context.setOffline(true)
  await page.keyboard.type(' written offline')
  await expect(page.locator('.save-status')).toContainText('Offline', { timeout: 30_000 })
  await context.setOffline(false)
  await waitSaved(page)
  await context.close()
})

function flipCiphertext(envelope) {
  return JSON.stringify({ ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` })
}

async function twoNotes(browser, prefix) {
  const email = uniqueEmail(prefix)
  const { context, page } = await newDevice(browser)
  await signupViaUi(page, { email })
  await newNote(page)
  await page.keyboard.type('Healthy note')
  await waitSaved(page)
  await newNote(page)
  await page.keyboard.type('Doomed note')
  await waitSaved(page)
  await context.close()
  const user = (await sql('SELECT id FROM users WHERE email = $1', [email]))[0]
  const doomed = (await sql('SELECT * FROM notes WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]))[0]
  return { email, doomed }
}

test('one undecryptable note is flagged and does not hide the others (DATA-8)', async ({ browser }) => {
  const { email, doomed } = await twoNotes(browser, 'corrupt')
  await sql('UPDATE notes SET encrypted_summary = $2, encrypted_content = $3 WHERE id = $1', [
    doomed.id,
    flipCiphertext(doomed.encrypted_summary),
    flipCiphertext(doomed.encrypted_content),
  ])

  const { context, page } = await newDevice(browser)
  await loginViaUi(page, { email })
  await expect(page.locator('.note-item')).toHaveCount(2)
  await expect(page.locator('.note-item-title').getByText('Healthy note')).toBeVisible()
  await expect(page.getByText("Can't decrypt this note")).toBeVisible()
  await page.getByText("Can't decrypt this note").click()
  await expect(page.getByRole('heading', { name: "This note can't be decrypted" })).toBeVisible()
  // The damaged record is left as it was.
  const after = (await sql('SELECT revision, encrypted_content FROM notes WHERE id = $1', [doomed.id]))[0]
  expect(after.revision).toBe(doomed.revision)
  expect(JSON.stringify(after.encrypted_content)).toBe(flipCiphertext(doomed.encrypted_content))
  await context.close()
})

test('a damaged summary is rebuilt from the readable note (DATA-8)', async ({ browser }) => {
  const { email, doomed } = await twoNotes(browser, 'summary')
  await sql('UPDATE notes SET encrypted_summary = $2 WHERE id = $1', [doomed.id, flipCiphertext(doomed.encrypted_summary)])

  const { context, page } = await newDevice(browser)
  await loginViaUi(page, { email })
  await expect(page.locator('.note-item-title').getByText('Doomed note')).toBeVisible()
  await expect(page.locator('.note-badge-error')).toHaveCount(0)
  await expect.poll(async () => (await sql('SELECT encrypted_summary FROM notes WHERE id = $1', [doomed.id]))[0].encrypted_summary.iv).not.toBe(doomed.encrypted_summary.iv)
  expect((await sql('SELECT revision FROM notes WHERE id = $1', [doomed.id]))[0].revision).toBe(doomed.revision)
  await context.close()
})
