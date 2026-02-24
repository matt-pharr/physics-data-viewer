/**
 * LSP Registry
 *
 * Manages the catalog of Language Server Protocol server definitions.
 * Definitions are layered: built-in defaults < module contributions < user overrides.
 */

export type LspTransport = 'stdio' | 'tcp';

/** One candidate command/executable to try for a language server */
export interface LspCandidate {
  /** The executable to run */
  command: string;
  /** Arguments to pass to the executable */
  args: string[];
  /** The executable name to probe on PATH (may differ from command) */
  detectCommand: string;
}

/** Full definition of an LSP server for one language */
export interface LspServerDefinition {
  languageId: string;
  displayName: string;
  fileExtensions: string[];
  transport: LspTransport;
  /** Candidates tried in order; first one found on PATH wins */
  candidates: LspCandidate[];
  /** TCP ports to probe when looking for an already-running external server */
  detectPorts: number[];
  documentationUrl: string;
  installHint: string;
  /** Whether PDV should auto-start the server on launch if launchable */
  autoStartDefault: boolean;
  /** Source attribution (undefined = built-in, string = module name) */
  source?: string;
}

const BUILT_IN_DEFINITIONS: LspServerDefinition[] = [
  {
    languageId: 'python',
    displayName: 'Python',
    fileExtensions: ['.py'],
    transport: 'stdio',
    candidates: [
      { command: 'pylsp', args: [], detectCommand: 'pylsp' },
      { command: 'pyright-langserver', args: ['--stdio'], detectCommand: 'pyright-langserver' },
      { command: 'jedi-language-server', args: [], detectCommand: 'jedi-language-server' },
    ],
    detectPorts: [2087, 2088],
    documentationUrl: 'https://github.com/python-lsp/python-lsp-server',
    installHint: 'pip install python-lsp-server',
    autoStartDefault: true,
  },
  {
    languageId: 'julia',
    displayName: 'Julia',
    fileExtensions: ['.jl'],
    transport: 'stdio',
    candidates: [
      {
        command: 'julia',
        args: [
          '--startup-file=no',
          '--history-file=no',
          '-e',
          'using LanguageServer; runserver()',
        ],
        detectCommand: 'julia',
      },
    ],
    detectPorts: [2001],
    documentationUrl: 'https://github.com/julia-vscode/LanguageServer.jl',
    installHint: "julia -e 'import Pkg; Pkg.add(\"LanguageServer\")'",
    autoStartDefault: false,
  },
];

export class LspRegistry {
  private definitions = new Map<string, LspServerDefinition>();

  constructor() {
    for (const def of BUILT_IN_DEFINITIONS) {
      this.definitions.set(def.languageId, def);
    }
  }

  /** Add or replace a definition (used by modules and user overrides) */
  register(def: LspServerDefinition): void {
    this.definitions.set(def.languageId, def);
  }

  /** Remove a definition (used when a module is disabled) */
  unregister(languageId: string): void {
    this.definitions.delete(languageId);
  }

  get(languageId: string): LspServerDefinition | undefined {
    return this.definitions.get(languageId);
  }

  list(): LspServerDefinition[] {
    return Array.from(this.definitions.values());
  }
}

let registry: LspRegistry | null = null;

export function getLspRegistry(): LspRegistry {
  if (!registry) {
    registry = new LspRegistry();
  }
  return registry;
}
