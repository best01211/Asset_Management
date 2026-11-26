import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import AssistantLauncher from './assistant-launcher'
import './globals.css'

export const metadata: Metadata = {
  title: '개인 금융 관리',
  description: '거래 검토, 자산 및 예산 관리',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ko"><body>
    {children}
    <AssistantLauncher />
  </body></html>
}
