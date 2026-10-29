import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, LayoutList, Lock, ArrowRight } from 'lucide-react'

const INTRO_MESSAGES = ['Write everything down.', "What's on your mind?"]
const FINAL_PREFIX = 'Your thoughts, '
const FINAL_WORD = 'secured.'
const CRYPTO_GLYPHS = '01ABCDEF#$%&*'

const DEMO_NOTES = [
  {
    id: 'trip-planning',
    title: 'Trip Planning',
    updatedAt: 'Today',
    preview: 'Flights, sunrise plans, and restaurants to save before the weekend.',
    lines: [
      { text: 'Book Lisbon hotel with late check-in', width: '88%' },
      { text: 'Save tram route to Alfama for day one', width: '81%' },
      { text: 'Paste the restaurant list from group chat', width: '84%' },
    ],
  },
  {
    id: 'meeting-notes',
    title: 'Meeting Notes',
    updatedAt: 'Yesterday',
    preview: 'Launch blockers, ownership, and the short list for Friday.',
    lines: [
      { text: 'Homepage polish ships with the onboarding refresh', width: '93%' },
      { text: 'Cache note summaries locally after unlock', width: '79%' },
      { text: 'Follow up with design on motion timing', width: '74%' },
    ],
  },
  {
    id: 'ideas',
    title: 'Ideas',
    updatedAt: 'Mar 4',
    preview: 'Small product experiments worth testing once the basics are fast.',
    lines: [
      { text: 'Daily recap note generated from completed todos', width: '91%' },
      { text: 'Pin favorite notes above the recent list', width: '72%' },
      { text: 'Quick capture shortcut from the lock screen', width: '77%' },
    ],
  },
  {
    id: 'grocery-list',
    title: 'Grocery List',
    updatedAt: 'Mar 2',
    preview: 'Everything needed for pasta night and the rest of the week.',
    lines: [
      { text: 'Fresh basil, lemons, and parmesan', width: '66%' },
      { text: 'Coffee beans and sparkling water', width: '58%' },
      { text: 'Cherry tomatoes for pasta tonight', width: '63%' },
    ],
  },
]

function getTypewriterText(note) {
  return `${note.title}\n${note.lines.map((line) => line.text).join('\n')}`
}

function splitTypedText(typedText) {
  const [title = '', ...bodyLines] = typedText.split('\n')
  return {
    title,
    bodyLines,
  }
}

function buildCryptoWord(target) {
  return target
    .split('')
    .map((char, index) => {
      if (char === ' ') {
        return char
      }

      return CRYPTO_GLYPHS[(index * 11 + 5) % CRYPTO_GLYPHS.length]
    })
    .join('')
}

function buildResolvedCryptoWord(target, cryptoWord, resolvedCount) {
  return target
    .split('')
    .map((char, index) => {
      if (char === ' ') {
        return char
      }

      if (index < resolvedCount) {
        return target[index]
      }

      return cryptoWord[index]
    })
    .join('')
}

function buildTypedCryptoWord(cryptoWord, typedCount) {
  return cryptoWord.slice(0, typedCount)
}

const FINAL_CRYPTO_WORD = buildCryptoWord(FINAL_WORD)

function AnimatedMockupNote({ note, onAdvance }) {
  const [typedChars, setTypedChars] = useState(0)
  const fullText = getTypewriterText(note)
  const typedText = fullText.slice(0, typedChars)
  const { title: typedTitle, bodyLines: typedBodyLines } = splitTypedText(typedText)
  const titleFinished = typedChars > note.title.length
  const typingComplete = typedChars >= fullText.length

  useEffect(() => {
    let timer = null

    if (typedChars < fullText.length) {
      const nextCharacter = fullText[typedChars]
      const delay = nextCharacter === '\n' ? 180 : nextCharacter === ' ' ? 26 : 40
      timer = window.setTimeout(() => {
        setTypedChars((value) => value + 1)
      }, delay)
    } else {
      timer = window.setTimeout(() => {
        onAdvance()
      }, 1700)
    }

    return () => window.clearTimeout(timer)
  }, [fullText, onAdvance, typedChars])

  return (
    <>
      <div className="mockup-editor-title">
        {typedTitle || <span className="mockup-hidden-text">{note.title}</span>}
        {!titleFinished && <span className="mockup-caret" aria-hidden="true" />}
      </div>

      <div className="mockup-editor-body">
        {note.lines.map((line, index) => {
          const typedLine = typedBodyLines[index] || ''
          const showCaret =
            titleFinished &&
            !typingComplete &&
            index === Math.max(typedBodyLines.length - 1, 0)

          if (typedLine) {
            return (
              <div key={line.text} className="mockup-typed-line">
                {typedLine}
                {showCaret && <span className="mockup-caret" aria-hidden="true" />}
              </div>
            )
          }

          return (
            <div
              key={line.text}
              className="mockup-typed-line mockup-typed-line-ghost"
              style={{ width: line.width }}
            />
          )
        })}
      </div>
    </>
  )
}

export default function Landing() {
  const navigate = useNavigate()
  const [headlineIndex, setHeadlineIndex] = useState(0)
  const [headlineChars, setHeadlineChars] = useState(0)
  const [headlinePhase, setHeadlinePhase] = useState('introTyping')
  const [cryptoTypedCount, setCryptoTypedCount] = useState(0)
  const [scrambleProgress, setScrambleProgress] = useState(0)
  const [activeNoteIndex, setActiveNoteIndex] = useState(0)

  const activeNote = DEMO_NOTES[activeNoteIndex]

  useEffect(() => {
    if (headlinePhase === 'done') {
      return undefined
    }

    let timer = null

    if (headlinePhase === 'introTyping') {
      const currentMessage = INTRO_MESSAGES[headlineIndex]
      if (headlineChars < currentMessage.length) {
        const nextCharacter = currentMessage[headlineChars]
        const delay = nextCharacter === ' ' ? 40 : 58
        timer = window.setTimeout(() => {
          setHeadlineChars((value) => value + 1)
        }, delay)
      } else {
        timer = window.setTimeout(() => {
          setHeadlinePhase('introHolding')
        }, 140)
      }
    } else if (headlinePhase === 'introHolding') {
      timer = window.setTimeout(() => {
        setHeadlinePhase('introDeleting')
      }, 2000)
    } else if (headlinePhase === 'introDeleting') {
      if (headlineChars > 0) {
        timer = window.setTimeout(() => {
          setHeadlineChars((value) => value - 1)
        }, 32)
      } else {
        timer = window.setTimeout(() => {
          if (headlineIndex < INTRO_MESSAGES.length - 1) {
            setHeadlineIndex((value) => value + 1)
            setHeadlinePhase('introTyping')
          } else {
            setHeadlinePhase('finalPrefixTyping')
          }
        }, 160)
      }
    } else if (headlinePhase === 'finalPrefixTyping') {
      if (headlineChars < FINAL_PREFIX.length) {
        const nextCharacter = FINAL_PREFIX[headlineChars]
        const delay = nextCharacter === ' ' ? 40 : 58
        timer = window.setTimeout(() => {
          setHeadlineChars((value) => value + 1)
        }, delay)
      } else {
        timer = window.setTimeout(() => {
          setHeadlinePhase('finalWordTyping')
        }, 120)
      }
    } else if (headlinePhase === 'finalWordTyping') {
      if (cryptoTypedCount < FINAL_WORD.length) {
        timer = window.setTimeout(() => {
          setCryptoTypedCount((value) => value + 1)
        }, 84)
      } else {
        timer = window.setTimeout(() => {
          setHeadlinePhase('finalWordResolve')
        }, 160)
      }
    } else if (headlinePhase === 'finalWordResolve') {
      if (scrambleProgress < FINAL_WORD.length) {
        timer = window.setTimeout(() => {
          setScrambleProgress((value) => value + 1)
        }, 92)
      } else {
        timer = window.setTimeout(() => {
          setHeadlinePhase('done')
        }, 120)
      }
    } else {
      timer = window.setTimeout(() => {
        setHeadlinePhase('done')
      }, 160)
    }

    return () => window.clearTimeout(timer)
  }, [cryptoTypedCount, headlineChars, headlineIndex, headlinePhase, scrambleProgress])

  const introText = INTRO_MESSAGES[headlineIndex] || ''
  const heroPrefix =
    headlinePhase === 'introTyping' ||
    headlinePhase === 'introHolding' ||
    headlinePhase === 'introDeleting'
      ? introText.slice(0, headlineChars)
      : FINAL_PREFIX.slice(0, headlineChars)

  const heroSecured = (() => {
    if (headlinePhase === 'finalWordTyping') {
      return buildTypedCryptoWord(FINAL_CRYPTO_WORD, cryptoTypedCount)
    }

    if (headlinePhase === 'finalWordResolve' || headlinePhase === 'done') {
      return buildResolvedCryptoWord(FINAL_WORD, FINAL_CRYPTO_WORD, scrambleProgress)
    }

    return ''
  })()

  const isResolvingFinalWord = headlinePhase === 'finalWordResolve' || headlinePhase === 'done'

  return (
    <div className="landing">
      <nav className="landing-nav">
        <span className="landing-nav-logo">Notes</span>
        <div className="landing-nav-actions">
          <button className="btn-ghost landing-signin" onClick={() => navigate('/login')}>
            Sign in
          </button>
          <button className="btn-primary" onClick={() => navigate('/signup')}>
            Get started
          </button>
        </div>
      </nav>

      <main>
        <section className="landing-hero">
          <h1 className="landing-hero-title">
            <span className="landing-hero-prefix">{heroPrefix}</span>
            {heroSecured && (
              <span
                className={`landing-hero-secured ${
                  headlinePhase === 'done'
                    ? 'is-final'
                    : isResolvingFinalWord
                      ? 'is-resolving'
                      : 'is-scrambling'
                }`}
              >
                {heroSecured.split('').map((char, index) => (
                  <span
                    key={index}
                    className={`landing-hero-secured-char ${
                      isResolvingFinalWord && index < scrambleProgress
                        ? 'is-revealed'
                        : 'is-scrambled'
                    } ${/[A-Za-z0-9]/.test(char) ? 'is-letter' : 'is-symbol'}`}
                  >
                    {char}
                  </span>
                ))}
              </span>
            )}
            {headlinePhase !== 'done' && (
              <span className="landing-hero-caret" aria-hidden="true" />
            )}
          </h1>
          <p className="landing-hero-sub">
            A notes app that gets out of your way. No clutter, no noise, just your thoughts,
            organized.
          </p>
          <div className="landing-hero-actions">
            <button className="btn-primary landing-btn-lg" onClick={() => navigate('/signup')}>
              Get started <ArrowRight size={15} />
            </button>
            <button className="btn-secondary landing-btn-lg" onClick={() => navigate('/login')}>
              Sign in
            </button>
          </div>
        </section>

        <section className="landing-preview">
          <div className="landing-app-mockup">
            <div className="mockup-sidebar">
              <div className="mockup-sidebar-header">All Notes</div>
              {DEMO_NOTES.map((note, index) => (
                <div
                  key={note.id}
                  className={`mockup-note-item ${index === activeNoteIndex ? 'mockup-active' : ''}`}
                >
                  <div className="mockup-note-title">{note.title}</div>
                  <div className="mockup-note-preview">{note.preview}</div>
                  <div className="mockup-note-meta">{note.updatedAt}</div>
                </div>
              ))}
            </div>

            <div className="mockup-editor">
              <div className="mockup-editor-header">
                <span className="mockup-editor-meta">{activeNote.updatedAt}</span>
              </div>

              <div className="mockup-editor-canvas">
                <AnimatedMockupNote
                  key={activeNote.id}
                  note={activeNote}
                  onAdvance={() => setActiveNoteIndex((value) => (value + 1) % DEMO_NOTES.length)}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="landing-features">
          <p className="landing-section-label">Why Notes</p>
          <div className="landing-features-grid">
            <div className="landing-feature-card">
              <div className="landing-feature-icon">
                <Zap size={18} />
              </div>
              <h3>Instant and fast</h3>
              <p>Opens in milliseconds. Saves automatically. Your notes are always there when you need them.</p>
            </div>
            <div className="landing-feature-card">
              <div className="landing-feature-icon">
                <LayoutList size={18} />
              </div>
              <h3>Organized by default</h3>
              <p>Notes are sorted and fully searchable. Find anything you've written in seconds.</p>
            </div>
            <div className="landing-feature-card">
              <div className="landing-feature-icon">
                <Lock size={18} />
              </div>
              <h3>End-to-end encrypted</h3>
              <p>Your notes are encrypted on your device before they ever leave. Only you can read them.</p>
            </div>
          </div>
        </section>

        <section className="landing-cta-section">
          <div className="landing-cta-inner">
            <h2>Start writing today.</h2>
            <p>Free to use. No credit card needed.</p>
            <button className="landing-cta-btn" onClick={() => navigate('/signup')}>
              Create an account <ArrowRight size={15} />
            </button>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span className="landing-footer-logo">Notes</span>
        <p>Free to use.</p>
      </footer>
    </div>
  )
}
