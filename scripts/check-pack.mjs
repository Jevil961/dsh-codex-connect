import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

// `spawnSync('npm', ...)` resolves to npm.cmd on Windows shells, but Node's
// direct process creation does not apply PATHEXT lookup. Use cmd.exe to invoke
// the shim explicitly so the release contract also runs from Windows.
const npmArguments = ['pack', '--dry-run', '--json', '--ignore-scripts']
const npmExecutable = process.platform === 'win32' ? 'cmd.exe' : 'npm'
const executableArguments = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm.cmd', ...npmArguments]
  : npmArguments
const result = spawnSync(npmExecutable, executableArguments, {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

const [manifest] = JSON.parse(result.stdout)
const names = manifest.files.map(file => file.path)
const required = ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'compatibility.json', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/bin.js']
for (const name of required) {
  if (!names.includes(name)) throw new Error(`packed artifact is missing ${name}`)
}

const forbidden = names.filter(name => /(^|\/)(?:\.env(?:\.|$)|\.git|node_modules|tests?|scripts?|src)(?:\/|$)|auth\.json$|credential|token/iu.test(name))
if (forbidden.length > 0) throw new Error(`packed artifact contains forbidden files: ${forbidden.join(', ')}`)
if (names.includes('docs/design/codex-connect-images-v4.md')) {
  throw new Error('core packed artifact must not include the images implementation design')
}

const declaration = await readFile(new URL('../lib/index.d.ts', import.meta.url), 'utf8')
if (!/declare module ['"]@deepseek-ai\/cordis['"]/u.test(declaration)) {
  throw new Error('lib/index.d.ts lost the Cordis Context augmentation')
}
if (!/openaiCodexTransport/u.test(declaration)) {
  throw new Error('lib/index.d.ts does not expose openaiCodexTransport')
}
if (!/IMAGE_GENERATE_TOOL_NAME/u.test(declaration)) {
  throw new Error('lib/index.d.ts does not expose the bundled image generation tool')
}

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!/codex_connect_image_generate/u.test(client)) {
  throw new Error('lib/client.js does not register the image generation result view')
}

process.stdout.write(`validated ${names.length} packed files (${manifest.size} bytes, ${manifest.unpackedSize} unpacked bytes)\n`)
