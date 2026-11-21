import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

const { build } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Keep application identity and runtime files identical to the portable build.
// A separate output folder lets the installed build coexist with a running portable build.
export default {
  ...build,
  directories: { ...build.directories, output: 'release/installer' },
  win: { ...build.win, target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    installerLanguages: ['zh_CN', 'en_US'],
    language: '2052',
    displayLanguageSelector: false,
    runAfterFinish: true,
    artifactName: 'Xiaoyuzhou-${version}-Setup-${arch}.${ext}',
  },
}
