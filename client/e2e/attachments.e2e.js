import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  acknowledgeRecoveryKey,
  collectGarbage,
  createLegacyAccount,
  editor,
  legacyUploadFiles,
  loginViaUi,
  newNote,
  signupViaUi,
  sql,
  uniqueEmail,
  unlockViaUi,
  waitSaved,
} from './helpers.js'

// A 1x1 PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function images(page) {
  return page.locator('.editor-container .lazy-image-node')
}

test('deleting an image and undoing keeps the image, also after garbage collection (DATA-4)', async ({ page }) => {
  const email = uniqueEmail('undo')
  await signupViaUi(page, { email })
  await newNote(page)
  await page.keyboard.type('Picture below')
  await page.locator('.editor-toolbar input[accept="image/*"]').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  })
  await expect(images(page).locator('img')).toHaveAttribute('src', /^blob:/)
  await waitSaved(page)
  const user = (await sql('SELECT id FROM users WHERE email = $1', [email]))[0]
  const [blob] = await sql('SELECT id FROM blobs WHERE user_id = $1', [user.id])
  expect(blob).toBeTruthy()

  await images(page).click()
  await page.keyboard.press('Delete')
  await expect(images(page)).toHaveCount(0)
  await waitSaved(page)
  // Removing it from the note no longer deletes the file right away.
  expect(await sql('SELECT id FROM blobs WHERE id = $1', [blob.id])).toHaveLength(1)

  await page.keyboard.press('Control+z')
  await expect(images(page)).toHaveCount(1)
  await waitSaved(page)

  // Even an old file with no grace period survives while a note uses it.
  await sql("UPDATE blobs SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [blob.id])
  await collectGarbage()
  await collectGarbage()
  expect(await sql('SELECT id FROM blobs WHERE id = $1', [blob.id])).toHaveLength(1)

  await page.reload()
  await unlockViaUi(page)
  await expect(editor(page)).toContainText('Picture below')
  await expect(images(page).locator('img')).toHaveAttribute('src', /^blob:/)
})

test('a 1.x account upgrades in the browser: notes and files end up encrypted (DATA-5, CRYPTO-2, CRYPTO-3)', async ({ page }) => {
  const email = uniqueEmail('legacy')
  const oldPassword = 'old-legacy-password'
  const stamp = Date.now()
  const image = `e2e-${stamp}-photo.png`
  const pdf = `e2e-${stamp}-tax.pdf`
  const { userId } = await createLegacyAccount({
    email,
    password: oldPassword,
    files: { [image]: PNG_BASE64, [pdf]: Buffer.from('%PDF-1.4 secret tax return').toString('base64') },
    notes: [
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Taxes 2025' }] },
          { type: 'image', attrs: { src: `/api/uploads/${image}` } },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'the return', marks: [{ type: 'link', attrs: { href: `/api/uploads/${pdf}` } }] }],
          },
        ],
      },
    ],
  })

  await loginViaUi(page, { email, password: oldPassword })
  await expect(page.getByRole('heading', { name: 'Encrypt your notes' })).toBeVisible()
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Repeat the new password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Encrypt my notes' }).click()
  await acknowledgeRecoveryKey(page)

  await expect(editor(page)).toContainText('Taxes 2025')
  await expect(images(page).locator('img')).toHaveAttribute('src', /^blob:/)
  await expect(editor(page).getByText('the return')).toBeVisible()

  // The server now holds ciphertext only, and the plaintext files left the
  // served directory.
  const rows = await sql('SELECT content, encrypted_content, encrypted_summary FROM notes WHERE user_id = $1', [userId])
  expect(rows).toHaveLength(1)
  expect(rows[0].content).toBeNull()
  expect(JSON.stringify(rows)).not.toContain('Taxes 2025')
  expect(await sql('SELECT id FROM blobs WHERE user_id = $1', [userId])).toHaveLength(2)
  const remaining = await legacyUploadFiles()
  expect(remaining).not.toContain(image)
  expect(remaining).not.toContain(pdf)

  // CRYPTO-2: the old password no longer signs in.
  const oldLogin = await page.request.post('/api/auth/login', { data: { email, password: oldPassword } })
  expect(oldLogin.ok()).toBe(false)
})
