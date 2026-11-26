'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import CatalogWorkspace from './finance-settings/categories/workspace'
import './finance-settings/categories/categories.css'

export default function SettingsWindow({ label = '설정', initialOpen = false, demo = false }: {
  label?: string; initialOpen?: boolean; demo?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [open, setOpen] = useState(initialOpen)

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
  }, [open])

  function close() {
    setOpen(false)
    if (initialOpen) {
      const url = new URL(window.location.href)
      if (url.searchParams.get('tab') === 'categories') {
        url.searchParams.delete('tab')
        window.history.replaceState(null, '', url)
      }
    }
  }

  return <>
    <button type="button" className="settings-window-trigger" aria-haspopup="dialog" aria-controls={id}
      onClick={() => setOpen(true)}>{label}</button>
    <dialog ref={dialog} id={id} className="finance-settings-dialog category-catalog-screen" aria-labelledby={id + '-title'} onClose={close}>
      <header className="settings-window-heading">
        <h2 id={id + '-title'}>설정</h2>
        <button type="button" className="outline" onClick={() => dialog.current?.close()}>닫기</button>
      </header>
      {open && <div className="settings-window-content">
        <div className="settings-window-section">
          <h3>카테고리·태그 관리</h3>
          <div className="row-actions">
            <Link href={demo ? '/demo/accounts' : '/finance-settings'} onNavigate={() => dialog.current?.close()}>계좌 설정</Link>
            <Link href="/category-rules" onNavigate={() => dialog.current?.close()}>가맹점 분류 규칙</Link>
          </div>
        </div>
        <CatalogWorkspace />
      </div>}
    </dialog>
  </>
}
