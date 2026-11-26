'use client'

import { useEffect } from 'react'

export function canLeaveDraft() {
  if (document.querySelector('[data-saving="true"]')) return false
  return !document.querySelector('[data-unsaved="true"]') || window.confirm('저장하지 않은 변경사항을 버리시겠습니까?')
}

export function useUnsavedDraft(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const guardLink = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.download || link.target === '_blank'
        || (link.hash && link.pathname === location.pathname) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.dataset.draftGuard) return
      if (!canLeaveDraft()) event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', guardLink, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', guardLink, true)
    }
  }, [dirty])
}
