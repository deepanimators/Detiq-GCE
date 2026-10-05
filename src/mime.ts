import path from 'path';

const MIME_MAP: Record<string, string> = {
  // Text / code
  ts: 'text/plain', tsx: 'text/plain', js: 'application/javascript',
  jsx: 'text/plain', mjs: 'application/javascript', cjs: 'application/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go',
  rs: 'text/x-rust', java: 'text/x-java', kt: 'text/x-kotlin',
  swift: 'text/x-swift', cs: 'text/x-csharp', cpp: 'text/x-c++src',
  c: 'text/x-csrc', h: 'text/x-chdr', php: 'text/x-php',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  ps1: 'text/plain', lua: 'text/x-lua', r: 'text/x-r',
  scala: 'text/x-scala', hs: 'text/x-haskell', ex: 'text/x-elixir',
  exs: 'text/x-elixir', erl: 'text/x-erlang',

  // Markup / config
  html: 'text/html', htm: 'text/html', xml: 'text/xml',
  md: 'text/markdown', mdx: 'text/markdown', rst: 'text/x-rst',
  txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml',
  toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
  env: 'text/plain', properties: 'text/plain',

  // Web
  css: 'text/css', scss: 'text/x-scss', sass: 'text/x-sass',
  less: 'text/x-less', svg: 'image/svg+xml',

  // Images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  bmp: 'image/bmp', tiff: 'image/tiff',

  // Fonts
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject',

  // Documents
  pdf: 'application/pdf',

  // Archives
  zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', rar: 'application/x-rar-compressed',

  // Binary / compiled
  wasm: 'application/wasm',
};

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}
