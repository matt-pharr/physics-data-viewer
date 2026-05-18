/**
 * mcp-instructions.ts — The `instructions` string advertised to MCP clients.
 *
 * An MCP server may send an `instructions` string in its `initialize`
 * response; compliant clients surface it to the model. PDV uses it to set
 * the working contract for an agent operating on a project: how PDV scripts
 * are structured, the runtime-vs-filesystem division of labour, and the rule
 * that all computation must be authored into PDV (ARCHITECTURE.md §15.11).
 *
 * Kept deliberately terse — this text is always in the model's context.
 */

/**
 * Instructions advertised to every connecting MCP client.
 */
export const MCP_INSTRUCTIONS = `PDV (Physics Data Viewer) exposes the active project through these tools.

PDV owns the runtime: the live project Tree, data, the kernel namespace, and
the running kernel. You own the filesystem: scripts, notes, and GUI files are
plain files on disk — read and edit them with your own file tools. PDV tools
return file paths for file-backed nodes; use the resolve_path tool to
translate between an on-disk path and a Tree path (PDV stores files under
opaque tree/<uuid>/ directories, so a raw path is not legible on its own).

Every PDV script defines run(pdv_tree: dict, **user_params) -> dict. The
pdv_tree argument is injected by PDV and is never supplied by the caller.

All computation on this project must be authored as PDV scripts (or code
cells) and run through PDV so results integrate into the project Tree. Do not
run ad-hoc analysis or produce plots outside PDV.

Use the pdv_help tool to introspect the pdv library API and any project symbol.
`;
