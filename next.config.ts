import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['@napi-rs/canvas', 'pdfjs-dist', 'pdfkit', 'sharp', 'tesseract.js', 'tesseract.js-core'],
  outputFileTracingIncludes: {
    '/api/monthly-reports': ['./node_modules/@expo-google-fonts/noto-sans-kr/400Regular/*.ttf'],
    '/api/pending-transactions/**/attachments/ocr': [
      './node_modules/@tesseract.js-data/{kor,eng}/4.0.0_best_int/*.gz',
      './node_modules/tesseract.js/src/worker-script/**/*',
      './node_modules/tesseract.js-core/*.wasm*',
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/pdfjs-dist/standard_fonts/**/*',
    ],
  },
}

export default config
