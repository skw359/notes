import { useEffect, useState } from 'react'

// `dismissible={false}` disables the backdrop click and Escape: used where
// closing by accident would lose something (the recovery key, CRYPTO-4).
export default function Modal({
  isOpen,
  onClose,
  children,
  contentClassName = '',
  overlayClassName = '',
  dismissible = true,
  labelledBy,
}) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    let frame = null
    let timer = null

    if (isOpen) {
      frame = requestAnimationFrame(() => {
        setVisible(true)
        setClosing(false)
      })
    } else if (visible) {
      frame = requestAnimationFrame(() => {
        setClosing(true)
      })
      timer = setTimeout(() => {
        setVisible(false)
        setClosing(false)
      }, 250)
    }

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [isOpen, visible])

  useEffect(() => {
    if (!visible || !dismissible) {
      return undefined
    }
    function handleKey(event) {
      if (event.key === 'Escape') {
        onClose?.()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [dismissible, onClose, visible])

  if (!visible) return null

  function handleClose() {
    onClose?.()
  }

  return (
    <div
      className={['modal-overlay', closing ? 'closing' : '', overlayClassName].filter(Boolean).join(' ')}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) handleClose()
      }}
    >
      <div
        className={['modal-content', contentClassName].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {typeof children === 'function' ? children(handleClose) : children}
      </div>
    </div>
  )
}
