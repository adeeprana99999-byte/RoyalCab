const zlib = require('node:zlib');
function xml(s = '') { return s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function csv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if (c === '\n' && !quoted) { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('Unclosed CSV quotation');
  if (row.length || value) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Invalid Excel archive');
  const count = buf.readUInt16LE(end + 10); let pos = buf.readUInt32LE(end + 16), total = 0; const files = {};
  if (count > 300) throw new Error('Workbook has too many components');
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid workbook directory');
    const flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10), size = buf.readUInt32LE(pos + 20), rawSize = buf.readUInt32LE(pos + 24);
    const len = buf.readUInt16LE(pos + 28), extra = buf.readUInt16LE(pos + 30), comment = buf.readUInt16LE(pos + 32), off = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + len).toString(); pos += 46 + len + extra + comment;
    total += rawSize;
    if (flags & 1 || total > 20 * 1024 * 1024 || size > 5 * 1024 * 1024) throw new Error('Encrypted or oversized workbook');
    if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet1\.xml)$/.test(name)) continue;
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('Invalid workbook entry');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const packed = buf.subarray(start, start + size);
    if (![0, 8].includes(method)) throw new Error('Unsupported Excel compression');
    const data = method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: 20 * 1024 * 1024 }) : packed;
    if (data.length !== rawSize) throw new Error('Damaged workbook');
    files[name] = data.toString('utf8');
  }
  return files;
}
function xlsx(buf) {
  const files = unzip(buf), sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('Use the template: data must be on the first worksheet');
  const texts = s => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => xml(m[1])).join('');
  const strings = [...(files['xl/sharedStrings.xml'] || '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const rows = [];
  for (const match of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cell of match[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(cell[1]); if (!ref) throw new Error('Missing cell reference');
      let col = 0; for (const c of ref[1]) col = col * 26 + c.charCodeAt(0) - 64;
      if (col > 50) throw new Error('Too many columns');
      const content = cell[2] || '', type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(content)?.[1] || '';
      row[col - 1] = /<f\b/.test(content) ? '#FORMULA_NOT_ALLOWED' : type === 's' ? strings[+v] || '' : type === 'inlineStr' ? texts(content) : xml(v);
    }
    rows.push(row);
    if (rows.length > 1001) throw new Error('Import limit is 1,000 trips');
  }
  return rows;
}
function parseFile(filename, buf) {
  if (buf.length > 5 * 1024 * 1024) throw new Error('Maximum file size is 5 MB');
  const rows = /\.xlsx$/i.test(filename) ? xlsx(buf) : /\.csv$/i.test(filename) ? csv(buf.toString('utf8').replace(/^\uFEFF/, '')) : (() => { throw new Error('Choose an .xlsx or .csv file'); })();
  if (rows.length > 1001) throw new Error('Import limit is 1,000 trips');
  const headers = (rows.shift() || []).map(x => String(x).trim().toLowerCase().replace(/\s+/g, '_'));
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate column names');
  for (const key of ['trip_id', 'pickup_at', 'customer_name', 'customer_phone', 'pickup', 'destination', 'passengers']) if (!headers.includes(key)) throw new Error(`Missing column: ${key}`);
  return rows.filter(r => r.some(v => String(v || '').trim())).map((r, index) => ({ row: index + 2, ...Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])) }));
}
// Minimal Excel template writer; plain inline-string cells, one worksheet.
function workbook(rows) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Planned trips" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.map((row, ri) => `<row r="${ri + 1}">` + row.map((v, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>'
  };
  const locals = [], central = []; let offset = 0;
  function crc32(b) { let c = 0xffffffff; for (const n of b) { c ^= n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name), b = Buffer.from(text), crc = crc32(b), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, b); central.push(c, n); offset += h.length + n.length + b.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
module.exports = { parseFile, workbook };
