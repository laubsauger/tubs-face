const fs = require('fs');

const shellPath = 'src/client/ui/app-shell.tsx';
let shellCode = fs.readFileSync(shellPath, 'utf8');

function extractFunction(name) {
  const regex = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const match = shellCode.match(regex);
  if (!match) return null;
  shellCode = shellCode.replace(match[0], '');
  return match[0];
}

const panelsToExtract = ['ConnectionPanel', 'VoicePanel', 'FacePanel', 'StatsPanel', 'ChatPanel', 'PanelHeader'];
const extracted = {};

panelsToExtract.forEach(name => {
  const code = extractFunction(name);
  if (code) extracted[name] = code;
});

// For each panel, write to a file
for (const [name, code] of Object.entries(extracted)) {
  let fileCode = `import { useRef, type JSX } from 'react';\n`;
  fileCode += `import { useAppSelector } from '../react-store.js';\n`;
  fileCode += `import type { AppStore, PanelKey } from '../../state/app-state.js';\n`;
  if (name !== 'PanelHeader') {
    fileCode += `import { PanelHeader } from './PanelHeader.js';\n`;
  }
  // add generic imports just to be safe
  fileCode += `import { AppShellControls } from '../app-shell.js';\n`;
  fileCode += `import { formatUptime, formatAwakeElapsed, formatCurrency, formatTimestamp, resolveChatActor, isChatEntryVisible, renderChatPrefix } from '../utils/formatters.js';\n`;
  fileCode += `import { toggleFullscreen } from '../window-runtime.js';\n`;
  fileCode += `\nexport ${code}\n`;
  
  fs.writeFileSync(`src/client/ui/panels/${name}.tsx`, fileCode);
}

// Add imports to app-shell
let imports = '';
Object.keys(extracted).forEach(name => {
  if (name !== 'PanelHeader') {
     imports += `import { ${name} } from './panels/${name}.js';\n`;
  }
});
shellCode = imports + shellCode;

fs.writeFileSync(shellPath, shellCode);

// now let's pull all formatters out to utils/formatters.ts
let formattersCode = `import type { HealthResponse } from '../../../shared/contracts/http.js';\n`;
formattersCode += `import type { ChatEntry } from '../../../shared/contracts/chat.js';\n`;

function extractFormatter(name) {
  const regex = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`);
  const regexNonExport = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  let match = shellCode.match(regex) || shellCode.match(regexNonExport);
  if (match) {
    shellCode = shellCode.replace(match[0], '');
    return match[0].startsWith('export') ? match[0] : `export ${match[0]}`;
  }
  return null;
}

const formatters = ['formatUptime', 'formatAwakeElapsed', 'formatCurrency', 'formatTimestamp', 'resolveChatActor', 'isChatEntryVisible', 'renderChatPrefix'];
formatters.forEach(name => {
  const code = extractFormatter(name);
  if (code) formattersCode += code + '\n';
});
fs.writeFileSync('src/client/ui/utils/formatters.ts', formattersCode);
fs.writeFileSync(shellPath, shellCode);

console.log("Done.");
