import { NodeViewWrapper } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { ENCRYPTED_BLOB_PREFIX } from '../lib/noteContent.js'

function getBlobIdFromNode(node) {
  if (node?.attrs?.blobId) {
    return String(node.attrs.blobId)
  }

  if (typeof node?.attrs?.src === 'string' && node.attrs.src.startsWith(ENCRYPTED_BLOB_PREFIX)) {
    return node.attrs.src.slice(ENCRYPTED_BLOB_PREFIX.length)
  }

  return null
}

function getImmediateSrc(node) {
  const src = node?.attrs?.src
  if (typeof src !== 'string') {
    return null
  }

  return src.startsWith(ENCRYPTED_BLOB_PREFIX) ? null : src
}

function LazyEncryptedImageBody({ node, resolveBlobUrl, blobId, immediateSrc }) {
  const wrapperRef = useRef(null)
  const [visible, setVisible] = useState(
    () => !blobId || Boolean(immediateSrc) || typeof IntersectionObserver === 'undefined'
  )
  const [resolvedSrc, setResolvedSrc] = useState(() => immediateSrc)
  const [loading, setLoading] = useState(() => Boolean(blobId) && !immediateSrc)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!blobId || resolvedSrc || visible) {
      return
    }

    const element = wrapperRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      {
        rootMargin: '240px',
      }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [blobId, resolvedSrc, visible])

  useEffect(() => {
    if (!blobId || !visible || resolvedSrc) {
      return
    }

    let cancelled = false
    const controller = new AbortController()

    Promise.resolve(resolveBlobUrl?.(blobId, node.attrs?.mimeType, controller.signal))
      .then((url) => {
        if (cancelled || !url) {
          return
        }

        setResolvedSrc(url)
        setLoading(false)
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') {
          return
        }

        setLoading(false)
        setFailed(true)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [blobId, node.attrs?.mimeType, resolveBlobUrl, resolvedSrc, visible])

  return (
    <NodeViewWrapper className="lazy-image-node" ref={wrapperRef} contentEditable={false}>
      {resolvedSrc ? (
        <img src={resolvedSrc} alt={node.attrs?.alt || ''} />
      ) : (
        <div className={`lazy-image-placeholder ${loading ? 'is-loading' : ''} ${failed ? 'is-error' : ''}`}>
          {failed ? 'Image unavailable' : 'Loading image...'}
        </div>
      )}
    </NodeViewWrapper>
  )
}

export default function LazyEncryptedImage({ node, extension }) {
  const blobId = getBlobIdFromNode(node)
  const immediateSrc = getImmediateSrc(node)
  const imageKey = `${blobId || 'inline'}:${immediateSrc || ''}:${node.attrs?.mimeType || ''}`

  return (
    <LazyEncryptedImageBody
      key={imageKey}
      node={node}
      resolveBlobUrl={extension.options.resolveBlobUrl}
      blobId={blobId}
      immediateSrc={immediateSrc}
    />
  )
}
