'use client'

import { useEffect, useRef, useState } from 'react'

export default function AssistantLauncher() {
  const dialog = useRef<HTMLDialogElement>(null)
  const questionField = useRef<HTMLTextAreaElement>(null)
  const [question, setQuestion] = useState('')
  const [copyStatus, setCopyStatus] = useState('')

  useEffect(() => {
    const open = (event: Event) => {
      const text: unknown = (event as CustomEvent).detail
      if (typeof text !== 'string') return
      setQuestion(text)
      setCopyStatus('')
      if (!dialog.current?.open) dialog.current?.showModal()
    }
    window.addEventListener('finance-assistant:open', open)
    return () => window.removeEventListener('finance-assistant:open', open)
  }, [])

  return <>
    <button className="chatbot-launcher" type="button" aria-label="AI 금융 비서 열기" aria-haspopup="dialog"
      aria-controls="finance-assistant" onClick={() => dialog.current?.showModal()}>
      <span className="chatbot-logo" aria-hidden="true"><span /></span>
    </button>
    <dialog ref={dialog} id="finance-assistant" className="finance-assistant" aria-labelledby="finance-assistant-title"
      onClose={() => { setQuestion(''); setCopyStatus('') }}>
      <div className="finance-assistant-heading">
        <h2 id="finance-assistant-title">AI 금융 비서</h2>
        <button type="button" className="outline" onClick={() => dialog.current?.close()}>닫기</button>
      </div>
      {question ? <div className="finance-assistant-context">
        <p>질문을 복사해 ChatGPT에서 대화를 이어갈 수 있습니다.</p>
        <label>질문 초안<textarea ref={questionField} rows={5} readOnly value={question} /></label>
        <button type="button" className="outline" onClick={async () => {
          try { await navigator.clipboard.writeText(question); setCopyStatus('질문을 복사했습니다.') }
          catch { questionField.current?.focus(); questionField.current?.select(); setCopyStatus('선택한 질문을 직접 복사해 주세요.') }
        }}>질문 복사</button>
        {copyStatus && <p role="status">{copyStatus}</p>}
      </div> : <p>금융 비서 연결 전입니다. ChatGPT에서 새 대화를 시작할 수 있습니다.</p>}
      <a className="button" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT 열기 <span aria-hidden="true">↗</span></a>
    </dialog>
  </>
}
