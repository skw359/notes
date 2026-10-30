// Per-device preferences (not synced, not secret).
const STORAGE_KEY = 'notes-device-settings'

export const AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60, 240]

const DEFAULTS = {
  // SEC-11: lock the vault after this many idle minutes (0 = never).
  autoLockMinutes: 60,
  // Keep the encrypted local cache after logging out (faster next login on
  // a personal device). Off by default for shared devices.
  keepCacheOnLogout: false,
}

export function getDeviceSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setDeviceSettings(patch) {
  const next = { ...getDeviceSettings(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // private mode: settings last for this session only
  }
  return next
}
