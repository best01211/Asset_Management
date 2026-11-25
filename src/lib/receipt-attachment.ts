export const receiptBucket = 'purchase-receipts'
export const receiptSizeLimit = 4 * 1024 * 1024
export const receiptName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(jpg|png|pdf)$/
export const receiptTypes = new Map([
  ['image/jpeg', { ext: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) }],
  ['image/png', { ext: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  ['application/pdf', { ext: 'pdf', signature: Buffer.from('%PDF-') }],
])

export async function boundedAttachment(body: ReadableStream<Uint8Array> | null) {
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) return Buffer.concat(chunks, length)
      length += part.value.byteLength
      if (length > receiptSizeLimit) {
        await reader.cancel()
        return null
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
}
