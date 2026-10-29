import { useEffect, useState } from 'react'

export default function Modal({
  isOpen,
  onClose,
  children,
  contentClassName = '',
  overlayClassName = '',
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

  if (!visible) return null

  function handleClose() {
    onClose()
  }

  return (
    <div
      className={['modal-overlay', closing ? 'closing' : '', overlayClassName].filter(Boolean).join(' ')}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div className={['modal-content', contentClassName].filter(Boolean).join(' ')}>
        {typeof children === 'function' ? children(handleClose) : children}
      </div>
    </div>
  )
}
