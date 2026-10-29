import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EditorContent,
  ReactNodeViewRenderer,
  useEditor,
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Bold, ImagePlus, Italic, Underline as UnderlineIcon } from 'lucide-react'
import FindReplaceBar from './FindReplaceBar'
import LazyEncryptedImage from './LazyEncryptedImage.jsx'
import { SearchReplace } from '../extensions/SearchReplace'
import { createEmptyNoteContent } from '../lib/e2ee.js'

const EncryptedImage = Image.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      resolveBlobUrl: null,
    }
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      blobId: {
        default: null,
      },
      mimeType: {
        default: null,
      },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(LazyEncryptedImage)
  },
})

export default function NoteEditor({
  note,
  onUpdate,
  onUploadImage,
  resolveImageSrc,
  readOnly = false,
  autoFocus = false,
}) {
  const debounceRef = useRef(null)
  const noteIdRef = useRef(note?.id)
  const editorRef = useRef(null)
  const fileInputRef = useRef(null)
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [findReplaceMode, setFindReplaceMode] = useState('find')

  const flushSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
      if (editorRef.current) {
        const json = editorRef.current.getJSON()
        onUpdate(noteIdRef.current, json)
      }
    }
  }, [onUpdate])

  const handleUpdate = useCallback(
    ({ editor }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        const json = editor.getJSON()
        onUpdate(noteIdRef.current, json)
      }, 150)
    },
    [onUpdate]
  )

  const handleImageInsert = useCallback(
    async (file, editor) => {
      try {
        const uploaded = await onUploadImage(file)
        editor
          .chain()
          .focus()
          .setImage({
            src: uploaded.url,
            blobId: uploaded.blobId,
            mimeType: uploaded.mimeType,
          })
          .run()
      } catch {
        // silent fail
      }
    },
    [onUploadImage]
  )

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: true,
        autolink: true,
        linkOnPaste: true,
      }),
      EncryptedImage.configure({
        resolveBlobUrl: resolveImageSrc,
      }),
      SearchReplace,
    ],
    content: note?.content || createEmptyNoteContent(),
    onUpdate: readOnly ? undefined : handleUpdate,
    editorProps: {
      handlePaste(_view, event) {
        const items = event.clipboardData?.items
        if (!items) return false
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault()
            const file = item.getAsFile()
            if (file && editorRef.current) handleImageInsert(file, editorRef.current)
            return true
          }
        }
        return false
      },
      handleDrop(_view, event) {
        const files = event.dataTransfer?.files
        if (!files?.length) return false
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            event.preventDefault()
            if (editorRef.current) handleImageInsert(file, editorRef.current)
            return true
          }
        }
        return false
      },
    },
  })

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    if (editor && readOnly) {
      editor.setEditable(false)
    }
  }, [editor, readOnly])

  useEffect(() => {
    if (!editor || readOnly || !autoFocus) {
      return
    }

    editor.commands.focus('end')
  }, [autoFocus, editor, readOnly])

  useEffect(() => {
    if (editor && note) {
      noteIdRef.current = note.id
    }
  }, [editor, note])

  useEffect(() => {
    if (!editor) return
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

  useEffect(() => {
    const handleBeforeUnload = () => flushSave()
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      flushSave()
    }
  }, [flushSave])

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
          <button
            className="toolbar-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Insert image"
          >
            <ImagePlus size={16} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleImageInsert(file, editor)
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
}
