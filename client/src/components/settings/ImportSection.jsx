import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext.jsx'
import { buildImportPlan, runImport } from '../../lib/importer/index.js'

// ARCH-4: imports run in the browser. Notes are converted and encrypted
// here and uploaded through the normal API; the server never sees them.
export default function ImportSection() {
  const { api, vault, user } = useAuth()
  const inputRef = useRef(null)
  const [plan, setPlan] = useState(null)
  const [format, setFormat] = useState(null)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)

  function handleFiles(fileList) {
    const next = buildImportPlan(fileList)
    if (!next.format) {
      toast.error('No Markdown (.md) or HTML notes were found in that folder')
      return
    }
    setPlan(next)
    setFormat(next.format)
    setResult(null)
  }

  async function handleImport() {
    setProgress({ done: 0, total: plan.notesFor(format).length })
    try {
      const summary = await runImport({ api, vault, plan, format, userId: user.id, onProgress: setProgress })
      setResult(summary)
      toast.success(`Imported ${summary.created} note(s)`)
    } catch (error) {
      toast.error(error.message)
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <h3>Import notes</h3>
        <p className="settings-help">
          Choose the folder of an Apple Notes export (Markdown with frontmatter, or HTML) including its images/ and
          attachments/ folders. Notes are added to your existing ones (nothing is replaced) and keep their original dates.
          Files already imported on this device are skipped.
        </p>
        <input
          ref={inputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button type="button" className="btn-ghost" disabled={Boolean(progress)} onClick={() => inputRef.current?.click()}>
          Choose export folder
        </button>
      </div>

      {plan && (
        <div className="settings-block">
          <p className="settings-help">
            Found {plan.counts.markdown} Markdown note(s), {plan.counts.html} HTML note(s) and {plan.counts.media} image or
            attachment file(s).
          </p>
          {plan.counts.markdown > 0 && plan.counts.html > 0 && (
            <div className="form-group">
              <label htmlFor="import-format">Import from</label>
              <select id="import-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="markdown">Markdown files</option>
                <option value="html">HTML files</option>
              </select>
            </div>
          )}
          <button type="button" className="btn-primary" disabled={Boolean(progress)} onClick={handleImport}>
            {progress ? `Importing ${progress.done}/${progress.total}…` : `Import ${plan.notesFor(format).length} note(s)`}
          </button>
        </div>
      )}

      {result && (
        <div className="settings-block">
          <p className="settings-help">
            Created {result.created}, skipped {result.skipped} already imported, {result.attachments} attachment(s)
            encrypted, {result.missingMedia} missing image(s) shown as placeholders.
          </p>
          {result.failed.length > 0 && (
            <ul className="settings-facts">
              {result.failed.map((failure) => (
                <li key={failure.path}>
                  {failure.path}: {failure.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
