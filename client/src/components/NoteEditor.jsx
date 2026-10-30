import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Bold, ImagePlus, Italic, Paperclip, Underline as UnderlineIcon } from 'lucide-react'
import toast from 'react-hot-toast'
import FindReplaceBar from './FindReplaceBar'
import LazyEncryptedImage from './LazyEncryptedImage.jsx'
import { SearchReplace } from '../extensions/SearchReplace'
import {
  ATTACHMENT_SCHEME,
  buildAttachmentHref,
  createEmptyNoteContent,
  imageAttrsForBlob,
  parseAttachmentHref,
} from '../lib/noteContent.js'

// PERF-4: save after a 1 s pause, or every 5 s while typing continuously.
const DEBOUNCE_MS = 1000
const MAX_WAIT_MS = 5000
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])

const EncryptedImage = Image.extend({
  addOptions() {
    return { ...this.parent?.(), resolveBlobUrl: null }
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      blobId: { default: null },
      blobUuid: { default: null },
      blobVersion: { default: null },
      keyId: { default: null },
      mimeType: { default: null },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(LazyEncryptedImage)
  },
})

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * `onChange(json)` receives the document after a pause (the store saves it).
 * The imperative handle lets the parent flush the pending change before the
 * note is switched, the page is hidden or the vault is locked.
 */
const NoteEditor = forwardRef(function NoteEditor(
  {
    note,
    onChange,
    onDirtyChange,
    onUploadFile,
    resolveImageSrc,
    onOpenAttachment,
    maxUploadBytes,
    readOnly = false,
    autoFocus = false,
  },
  ref
) {
  const timerRef = useRef(null)
  const firstPendingAtRef = useRef(null)
  const editorRef = useRef(null)
  const imageInputRef = useRef(null)
  const fileInputRef = useRef(null)
  const onChangeRef = useRef(onChange)
  const onDirtyChangeRef = useRef(onDirtyChange)
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [findReplaceMode, setFindReplaceMode] = useState('find')

  useEffect(() => {
    onChangeRef.current = onChange
    onDirtyChangeRef.current = onDirtyChange
  }, [onChange, onDirtyChange])

  const flush = useCallback(() => {
    if (!timerRef.current) {
      return
    }
    clearTimeout(timerRef.current)
    timerRef.current = null
    firstPendingAtRef.current = null
    if (editorRef.current) {
      onChangeRef.current?.(editorRef.current.getJSON())
    }
    onDirtyChangeRef.current?.(false)
  }, [])

  const scheduleSave = useCallback(() => {
    const now = Date.now()
    firstPendingAtRef.current ??= now
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    } else {
      // Keystrokes waiting for the debounce are not saved yet (DATA-2).
      onDirtyChangeRef.current?.(true)
    }
    const waitedFor = now - firstPendingAtRef.current
    timerRef.current = setTimeout(flush, Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waitedFor)))
  }, [flush])

  useImperativeHandle(ref, () => ({ flush, hasPendingChange: () => Boolean(timerRef.current) }), [flush])

  const insertFile = useCallback(
    async (file, editor) => {
      if (maxUploadBytes && file.size > maxUploadBytes) {
        toast.error(`"${file.name}" is ${formatBytes(file.size)}; attachments can be at most ${formatBytes(maxUploadBytes)}.`)
        return
      }
      const pending = toast.loading(`Encrypting and uploading ${file.name}…`)
      try {
        const uploaded = await onUploadFile(file)
        if (INLINE_IMAGE_TYPES.has(uploaded.mimeType)) {
          editor.chain().focus().setImage(imageAttrsForBlob(uploaded)).run()
        } else {
          editor
            .chain()
            .focus()
            .insertContent({
              type: 'text',
              text: file.name,
              marks: [{ type: 'link', attrs: { href: buildAttachmentHref(uploaded) } }],
            })
            .insertContent(' ')
            .run()
        }
        toast.success('Attachment added', { id: pending })
      } catch (error) {
        // DATA-2: an upload failure is never silent.
        toast.error(`Could not add "${file.name}": ${error.message}`, { id: pending })
      }
    },
    [maxUploadBytes, onUploadFile]
  )

  const editor = useEditor({
    extensions: [
      // ARCH-5: Link and Underline come with StarterKit 3; configured once.
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          isAllowedUri: (url, ctx) => url.startsWith(ATTACHMENT_SCHEME) || ctx.defaultValidate(url),
        },
      }),
      EncryptedImage.configure({ resolveBlobUrl: resolveImageSrc }),
      SearchReplace,
    ],
    content: note?.content || createEmptyNoteContent(),
    editable: !readOnly,
    onUpdate: readOnly ? undefined : scheduleSave,
    editorProps: {
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files || [])]
        if (!files.length || readOnly) return false
        event.preventDefault()
        for (const file of files) {
          if (editorRef.current) void insertFile(file, editorRef.current)
        }
        return true
      },
      handleDrop(_view, event) {
        const files = [...(event.dataTransfer?.files || [])]
        if (!files.length || readOnly) return false
        event.preventDefault()
        for (const file of files) {
          if (editorRef.current) void insertFile(file, editorRef.current)
        }
        return true
      },
      handleClick(view, pos, event) {
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        if (!anchor) return false
        const href = anchor.getAttribute('href')
        const attachment = parseAttachmentHref(href)
        if (attachment) {
          event.preventDefault()
          onOpenAttachment?.(attachment)
          return true
        }
        if (event.metaKey || event.ctrlKey || readOnly) {
          window.open(href, '_blank', 'noopener,noreferrer')
          return true
        }
        return false
      },
    },
  })

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  // useEditor can hand out an instance it has already destroyed (it replaces
  // an editor whose first effects ran late and re-renders with the new one);
  // a destroyed editor has no commands.
  useEffect(() => {
    if (!editor || editor.isDestroyed || readOnly || !autoFocus) {
      return
    }
    editor.commands.focus('end')
  }, [autoFocus, editor, readOnly])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined
    const handleToggle = ({ mode }) => {
      if (mode === 'close') {
        setFindReplaceOpen(false)
        editor.commands.clearSearch()
      } else {
        setFindReplaceMode(mode)
        setFindReplaceOpen(true)
      }
    }
    editor.on('toggleFindReplace', handleToggle)
    return () => editor.off('toggleFindReplace', handleToggle)
  }, [editor])

  // Hand pending text to the store before the page goes away or the editor
  // unmounts; the store keeps it in its encrypted outbox until confirmed.
  useEffect(() => {
    const handleHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', handleHidden)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', handleHidden)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  if (!editor) return null

  return (
    <>
      {!readOnly && (
        <div className="editor-toolbar">
          <button
            className={`toolbar-btn ${editor.isActive('bold') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
          >
            <Bold size={16} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('italic') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
          >
            <Italic size={16} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('underline') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            title="Underline"
          >
            <UnderlineIcon size={16} />
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={() => imageInputRef.current?.click()} title="Insert image">
            <ImagePlus size={16} />
          </button>
          <button className="toolbar-btn" onClick={() => fileInputRef.current?.click()} title="Attach a file">
            <Paperclip size={16} />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void insertFile(file, editor)
              e.target.value = ''
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void insertFile(file, editor)
              e.target.value = ''
            }}
          />
        </div>
      )}
      <div className="editor-container">
        {findReplaceOpen && (
          <FindReplaceBar
            key={findReplaceMode}
            editor={editor}
            mode={findReplaceMode}
            onClose={() => {
              setFindReplaceOpen(false)
              editor.commands.clearSearch()
            }}
          />
        )}
        <EditorContent editor={editor} />
      </div>
    </>
  )
})

export default NoteEditor
