import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { findMatches } from './SearchReplace.js'

const schema = getSchema([StarterKit])

describe('find & replace', () => {
  it('does not match across a hard break (Replace all used to delete the break)', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'end of line' }, { type: 'hardBreak' }, { type: 'text', text: 'line start' }],
        },
      ],
    })
    // "lineline" exists only if the break is ignored.
    expect(findMatches(doc, 'lineline')).toEqual([])
    expect(findMatches(doc, 'line')).toHaveLength(2)
  })

  it('still matches across differently formatted text in one line', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo', marks: [{ type: 'bold' }] }] }],
    })
    expect(findMatches(doc, 'hello')).toEqual([{ from: 1, to: 6 }])
  })
})
