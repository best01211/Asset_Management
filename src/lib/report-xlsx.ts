import { strToU8, zipSync } from 'fflate'

const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const connections = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'

function xmlText(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function reportXlsx(rows: readonly (readonly [string, string, string])[]) {
  const values = rows.map((row, index) => {
    const number = index + 1
    return '<row r="' + number + '">' + row.map((value, column) =>
      '<c r="' + 'ABC'[column] + number + '" t="inlineStr"><is><t xml:space="preserve">' +
        xmlText(value) + '</t></is></c>').join('') + '</row>'
  }).join('')
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="' + relationships + '"><Relationship Id="rId1" Type="' +
      connections + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<workbook xmlns="' + spreadsheet + '" xmlns:r="' + connections +
      '"><bookViews><workbookView/></bookViews><sheets><sheet name="금융 보고서" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="' + relationships + '"><Relationship Id="rId1" Type="' +
      connections + '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet xmlns="' + spreadsheet + '">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/>' +
      '<col min="2" max="2" width="45" customWidth="1"/><col min="3" max="3" width="30" customWidth="1"/></cols>' +
      '<sheetData>' + values + '</sheetData></worksheet>'),
  })
}
