import { expect } from '@playwright/test'

export const PASSWORD = 'correct horse battery staple'
export const BASE_URL = `http://127.0.0.1:${process.env.E2E_APP_PORT || '4610'}`
const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT || '4611'}`

// A second browser profile (own cookies and IndexedDB), like another device.
export async function newDevice(browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  return { context, page: await context.newPage() }
}

async function control(path, body) {
  const response = await fetch(`${CONTROL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error || `control ${path} failed`)
  }
  return data
}

// Direct read/write access to the isolated test database.
export async function sql(text, params = []) {
  return (await control('/sql', { text, params })).rows
}

export async function verifyBrowserDerivation(email, password = PASSWORD) {
  return control('/verify-derivation', { email, password })
}

export async function serverStorage() {
  return (await control('/config')).storage
}

// files: { filename: base64 }; notes: ProseMirror documents.
export async function createLegacyAccount({ email, password, files, notes }) {
  return control('/legacy-account', { email, password, files, notes })
}

export async function legacyUploadFiles() {
  return (await control('/legacy-files')).files
}

export async function collectGarbage() {
  return control('/gc', {})
}

let counter = 0
export function uniqueEmail(prefix) {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}@example.com`
}

export async function acknowledgeRecoveryKey(page) {
  const shown = await page.getByTestId('recovery-key').textContent()
  const key = shown.replace(/\s/g, '')
  await page.getByLabel('I saved this recovery key somewhere safe').check()
  await page.getByLabel('Type the last 4 characters of the key').fill(key.slice(-4))
  await page.getByRole('button', { name: 'I saved it, continue' }).click()
  await expect(page.getByTestId('recovery-key')).toBeHidden()
  return key
}

export async function signupViaUi(page, { email, password = PASSWORD, first = 'Ada', last = 'Lovelace' }) {
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('First Name').fill(first)
  await page.getByLabel('Last Name').fill(last)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign Up' }).click()
  const recoveryKey = await acknowledgeRecoveryKey(page)
  await expect(page.getByTitle('New Note')).toBeVisible()
  return recoveryKey
}

export async function loginViaUi(page, { email, password = PASSWORD }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log In' }).click()
}

export async function unlockViaUi(page, password = PASSWORD) {
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Unlock' }).click()
}

export function editor(page) {
  return page.locator('.editor-container .ProseMirror')
}

export async function newNote(page) {
  await page.getByTitle('New Note').click()
  await expect(editor(page)).toBeVisible()
  await editor(page).click()
}

export async function waitSaved(page) {
  await expect(page.locator('.save-status')).toHaveText(/^Saved$/, { timeout: 30_000 })
}

// Everything this origin stored in IndexedDB, serialized.
export async function dumpIndexedDb(page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((db) => db.name)
    const dump = {}
    for (const name of names) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      for (const store of db.objectStoreNames) {
        dump[`${name}/${store}`] = await new Promise((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      }
      db.close()
    }
    return JSON.stringify(dump)
  })
}
