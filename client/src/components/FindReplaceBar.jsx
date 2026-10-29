import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, ChevronUp, ChevronDown, X, ArrowLeftRight } from 'lucide-react'

export default function FindReplaceBar({ editor, mode, onClose }) {
  const [searchTerm, setSearchTerm] = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [showReplace, setShowReplace] = useState(mode === 'replace')
  const searchRef = useRef(null)

  // Focus search input and pre-populate with selection on open
  useEffect(() => {
    if (editor && searchRef.current) {
      const { from, to } = editor.state.selection
      if (from !== to) {
        const selectedText = editor.state.doc.textBetween(from, to, '')
        if (selectedText && selectedText.length < 200) {
          window.requestAnimationFrame(() => setSearchTerm(selectedText))
          editor.commands.setSearchTerm(selectedText)
        }
      }
      searchRef.current.focus()
      searchRef.current.select()
    }
  }, [editor])

  // Sync match count/active index from extension storage
  const syncState = useCallback(() => {
    if (!editor) return
    const storage = editor.storage.searchReplace
    setMatchCount(storage.results.length)
    setActiveIndex(storage.activeIndex)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    editor.on('transaction', syncState)
    return () => editor.off('transaction', syncState)
  }, [editor, syncState])

  // Scroll active match into view
  useEffect(() => {
    if (!editor || matchCount === 0) return
    const storage = editor.storage.searchReplace
    const match = storage.results[storage.activeIndex]
    if (match) {
      const dom = editor.view.domAtPos(match.from)
      if (dom && dom.node) {
        const el = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }, [editor, activeIndex, matchCount])

  const handleSearchChange = (e) => {
    const val = e.target.value
    setSearchTerm(val)
    editor.commands.setSearchTerm(val)
  }

  const handleReplaceChange = (e) => {
    const val = e.target.value
    setReplaceTerm(val)
    editor.commands.setReplaceTerm(val)
  }

  const handleNext = () => editor.commands.goToNextResult()
  const handlePrev = () => editor.commands.goToPrevResult()

  const handleReplace = () => {
    editor.commands.replaceCurrent()
  }

  const handleReplaceAll = () => {
    editor.commands.replaceAll()
  }

  const handleClose = () => {
    editor.commands.clearSearch()
    setSearchTerm('')
    setReplaceTerm('')
    onClose()
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleNext()
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      handlePrev()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleClose()
    }
  }

  const handleReplaceKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleReplace()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleClose()
    }
  }

  return (
    <div className="find-replace-bar">
      <div className="find-replace-row">
        <div className="find-replace-input-wrap">
          <Search size={14} />
          <input
            ref={searchRef}
            type="text"
            value={searchTerm}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find"
            spellCheck={false}
          />
        </div>
        <span className="find-replace-count">
          {searchTerm
            ? matchCount > 0
              ? `${activeIndex + 1} of ${matchCount}`
              : 'No results'
            : ''}
        </span>
        <button className="find-replace-btn" onClick={handlePrev} title="Previous (Shift+Enter)">
          <ChevronUp size={14} />
        </button>
        <button className="find-replace-btn" onClick={handleNext} title="Next (Enter)">
          <ChevronDown size={14} />
        </button>
        <button
          className={`find-replace-btn ${showReplace ? 'is-active' : ''}`}
          onClick={() => setShowReplace((v) => !v)}
          title="Toggle Replace"
        >
          <ArrowLeftRight size={14} />
        </button>
        <button className="find-replace-btn" onClick={handleClose} title="Close (Escape)">
          <X size={14} />
        </button>
      </div>
      {showReplace && (
        <div className="find-replace-row">
          <div className="find-replace-input-wrap">
            <ArrowLeftRight size={14} />
            <input
              type="text"
              value={replaceTerm}
              onChange={handleReplaceChange}
              onKeyDown={handleReplaceKeyDown}
              placeholder="Replace"
              spellCheck={false}
            />
          </div>
          <button className="find-replace-btn-text" onClick={handleReplace}>
            Replace
          </button>
          <button className="find-replace-btn-text" onClick={handleReplaceAll}>
            All
          </button>
        </div>
      )}
    </div>
  )
}
