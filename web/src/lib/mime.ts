import path from 'path';

const MIME_MAP: Record<string, string> = {
  ts: 'text/plain', tsx: 'text/plain', js: 'application/javascript',
  jsx: 'text/plain', mjs: 'application/javascript', cjs: 'application/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go',
  rs: 'text/x-rust', java: 'text/x-java', kt: 'text/x-kotlin',
  swift: 'text/x-swift', cs: 'text/x-csharp', cpp: 'text/x-c++src',
  c: 'text/x-csrc', h: 'text/x-chdr', php: 'text/x-php',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  html: 'text/html', htm: 'text/html', xml: 'text/xml',
  md: 'text/markdown', mdx: 'text/markdown', txt: 'text/plain',
  csv: 'text/csv', json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml',
  toml: 'text/plain', ini: 'text/plain', env: 'text/plain',
  css: 'text/css', scss: 'text/x-scss', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  pdf: 'application/pdf', zip: 'application/zip', wasm: 'application/wasm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}
