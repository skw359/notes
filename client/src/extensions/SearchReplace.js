import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const searchReplaceKey = new PluginKey('searchReplace')

function findMatches(doc, searchTerm) {
  if (!searchTerm) return []
  const results = []
  const term = searchTerm.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    // Concatenate all inline text in this block with position tracking
    let fullText = ''
    const segments = []
    node.forEach((child, offset) => {
      if (child.isText) {
        segments.push({ from: pos + 1 + offset, text: child.text })
        fullText += child.text
      }
    })
    const lower = fullText.toLowerCase()
    let idx = 0
    while ((idx = lower.indexOf(term, idx)) !== -1) {
      // Map string offset back to document positions
      let charsSeen = 0
      let fromPos = 0
      let toPos = 0
      for (const seg of segments) {
        const segEnd = charsSeen + seg.text.length
        if (fromPos === 0 && idx < segEnd) {
          fromPos = seg.from + (idx - charsSeen)
        }
        const matchEnd = idx + term.length
        if (matchEnd <= segEnd) {
          toPos = seg.from + (matchEnd - charsSeen)
          break
        }
        charsSeen = segEnd
      }
      if (fromPos && toPos) {
        results.push({ from: fromPos, to: toPos })
      }
      idx += 1
    }
  })
  return results
}

function buildDecorations(doc, results, activeIndex) {
  const decorations = results.map((r, i) =>
    Decoration.inline(r.from, r.to, {
      class: i === activeIndex ? 'search-result search-result-active' : 'search-result',
    })
  )
  return DecorationSet.create(doc, decorations)
}

export const SearchReplace = Extension.create({
  name: 'searchReplace',

  addStorage() {
    return {
      searchTerm: '',
      replaceTerm: '',
      results: [],
      activeIndex: 0,
    }
  },

  addCommands() {
    return {
      setSearchTerm:
        (term) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(searchReplaceKey, { type: 'setSearchTerm', term })
          }
          return true
        },
      setReplaceTerm:
        (term) =>
        () => {
          this.storage.replaceTerm = term
          return true
        },
      goToNextResult:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(searchReplaceKey, { type: 'goToNext' })
          }
          return true
        },
      goToPrevResult:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(searchReplaceKey, { type: 'goToPrev' })
          }
          return true
        },
      replaceCurrent:
        () =>
        ({ tr, dispatch }) => {
          const { results, activeIndex, replaceTerm } = this.storage
          if (results.length === 0) return false
          const match = results[activeIndex]
          if (!match) return false
          if (dispatch) {
            tr.insertText(replaceTerm, match.from, match.to)
            tr.setMeta(searchReplaceKey, { type: 'reSearch' })
            dispatch(tr)
          }
          return true
        },
      replaceAll:
        () =>
        ({ tr, dispatch }) => {
          const { results, replaceTerm } = this.storage
          if (results.length === 0) return false
          if (dispatch) {
            // Replace from end to start to preserve positions
            const sorted = [...results].sort((a, b) => b.from - a.from)
            for (const match of sorted) {
              tr.insertText(replaceTerm, match.from, match.to)
            }
            tr.setMeta(searchReplaceKey, { type: 'reSearch' })
            dispatch(tr)
          }
          return true
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(searchReplaceKey, { type: 'clear' })
          }
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        this.editor.emit('toggleFindReplace', { mode: 'find' })
        return true
      },
      'Mod-h': () => {
        this.editor.emit('toggleFindReplace', { mode: 'replace' })
        return true
      },
      Escape: () => {
        if (this.storage.searchTerm) {
          this.editor.emit('toggleFindReplace', { mode: 'close' })
          return true
        }
        return false
      },
    }
  },

  addProseMirrorPlugins() {
    const extension = this
    return [
      new Plugin({
        key: searchReplaceKey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldDecorations, oldState, newState) {
            const meta = tr.getMeta(searchReplaceKey)
            if (meta) {
              switch (meta.type) {
                case 'setSearchTerm': {
                  extension.storage.searchTerm = meta.term
                  extension.storage.results = findMatches(newState.doc, meta.term)
                  extension.storage.activeIndex = 0
                  return buildDecorations(
                    newState.doc,
                    extension.storage.results,
                    extension.storage.activeIndex
                  )
                }
                case 'goToNext': {
                  const len = extension.storage.results.length
                  if (len > 0) {
                    extension.storage.activeIndex =
                      (extension.storage.activeIndex + 1) % len
                  }
                  return buildDecorations(
                    newState.doc,
                    extension.storage.results,
                    extension.storage.activeIndex
                  )
                }
                case 'goToPrev': {
                  const len = extension.storage.results.length
                  if (len > 0) {
                    extension.storage.activeIndex =
                      (extension.storage.activeIndex - 1 + len) % len
                  }
                  return buildDecorations(
                    newState.doc,
                    extension.storage.results,
                    extension.storage.activeIndex
                  )
                }
                case 'reSearch': {
                  extension.storage.results = findMatches(
                    newState.doc,
                    extension.storage.searchTerm
                  )
                  if (extension.storage.activeIndex >= extension.storage.results.length) {
                    extension.storage.activeIndex = Math.max(
                      0,
                      extension.storage.results.length - 1
                    )
                  }
                  return buildDecorations(
                    newState.doc,
                    extension.storage.results,
                    extension.storage.activeIndex
                  )
                }
                case 'clear': {
                  extension.storage.searchTerm = ''
                  extension.storage.replaceTerm = ''
                  extension.storage.results = []
                  extension.storage.activeIndex = 0
                  return DecorationSet.empty
                }
                default:
                  break
              }
            }
            // Re-search on doc changes if we have a search term
            if (tr.docChanged && extension.storage.searchTerm) {
              extension.storage.results = findMatches(
                newState.doc,
                extension.storage.searchTerm
              )
              if (extension.storage.activeIndex >= extension.storage.results.length) {
                extension.storage.activeIndex = Math.max(
                  0,
                  extension.storage.results.length - 1
                )
              }
              return buildDecorations(
                newState.doc,
                extension.storage.results,
                extension.storage.activeIndex
              )
            }
            return tr.docChanged ? oldDecorations.map(tr.mapping, tr.doc) : oldDecorations
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})
