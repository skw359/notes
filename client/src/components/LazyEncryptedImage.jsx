import { NodeViewWrapper } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { blobReferenceFromImageAttrs, ENCRYPTED_BLOB_PREFIX } from '../lib/noteContent.js'

function getImmediateSrc(node) {
  const src = node?.attrs?.src
  if (typeof src !== 'string' || src.startsWith(ENCRYPTED_BLOB_PREFIX)) {
    return null
  }
  // Only object URLs created on this page and inline data are shown directly.
  return src.startsWith('blob:') || src.startsWith('data:image/') ? src : null
}

function LazyEncryptedImageBody({ node, resolveBlobUrl, immediateSrc }) {
  // Keyed by the reference below, so it is fixed for this mount.
  const [reference] = useState(() => blobReferenceFromImageAttrs(node.attrs))
  const wrapperRef = useRef(null)
  const [visible, setVisible] = useState(
    () => !reference || Boolean(immediateSrc) || typeof IntersectionObserver === 'undefined'
  )
  const [resolvedSrc, setResolvedSrc] = useState(() => immediateSrc)
  const [loading, setLoading] = useState(() => Boolean(reference) && !immediateSrc)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!reference || resolvedSrc || visible) {
      return undefined
    }
    const element = wrapperRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '240px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [reference, resolvedSrc, visible])

  useEffect(() => {
    if (!reference || !visible || resolvedSrc) {
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    Promise.resolve(resolveBlobUrl?.(reference, controller.signal))
      .then((url) => {
        if (!cancelled && url) {
          setResolvedSrc(url)
          setLoading(false)
        }
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
  }, [reference, resolveBlobUrl, resolvedSrc, visible])

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
  const attrs = node.attrs || {}
  const immediateSrc = getImmediateSrc(node)
  const imageKey = `${attrs.blobId || attrs.src || 'inline'}:${attrs.blobUuid || ''}:${attrs.keyId || ''}:${immediateSrc || ''}`

  return (
    <LazyEncryptedImageBody
      key={imageKey}
      node={node}
      resolveBlobUrl={extension.options.resolveBlobUrl}
      immediateSrc={immediateSrc}
    />
  )
}
