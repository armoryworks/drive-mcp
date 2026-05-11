#!/usr/bin/env node
/**
 * Armory Works Drive MCP — server entry point.
 *
 * Speaks MCP over stdio. The MCP host (Claude Desktop or another compatible
 * client) spawns this as a subprocess and communicates via JSON-RPC on
 * stdin/stdout. Tools are exposed via the standard ListTools / CallTool
 * request handlers.
 *
 * Tool inventory:
 *   Drive:
 *     - move_file
 *     - rename_file
 *     - delete_file
 *     - restore_file
 *     - list_folder
 *   Docs:
 *     - find_and_replace
 *     - append_to_doc
 *     - insert_at_heading
 *     - apply_text_style
 *   Sheets:
 *     - append_row
 *     - update_cell
 *     - update_range
 *     - find_and_replace_in_sheet
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { wrapToolErrors } from './lib/errors.js';
import { hasValidAuth } from './auth.js';

import {
  moveFile, moveFileSchema,
  renameFile, renameFileSchema,
  deleteFile, deleteFileSchema,
  restoreFile, restoreFileSchema,
  listFolder, listFolderSchema,
} from './tools/drive.js';

import {
  findAndReplace, findAndReplaceSchema,
  appendToDoc, appendToDocSchema,
  insertAtHeading, insertAtHeadingSchema,
  applyTextStyle, applyTextStyleSchema,
} from './tools/docs.js';

import {
  appendRow, appendRowSchema,
  updateCell, updateCellSchema,
  updateRange, updateRangeSchema,
  findAndReplaceInSheet, findAndReplaceInSheetSchema,
} from './tools/sheets.js';

// =========================================================================
// Tool registry
// =========================================================================

// Each entry pairs a schema, a description, and a handler. The description
// is what the LLM reads when deciding which tool to call, so the writing
// matters. Schemas are zod; we convert to JSON Schema for MCP ListTools.

interface ToolDef<T extends z.ZodType> {
  name: string;
  description: string;
  schema: T;
  handler: (input: z.infer<T>) => Promise<unknown>;
}

function tool<T extends z.ZodType>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

const tools = [
  // ---- Drive ----
  tool({
    name: 'move_file',
    description:
      'Move a Google Drive file or folder into a different parent folder. Use this to organize files (e.g., move a doc from My Drive root into a project folder).',
    schema: moveFileSchema,
    handler: moveFile,
  }),
  tool({
    name: 'rename_file',
    description:
      'Rename a Google Drive file or folder (changes the title only; does not affect content). The file ID remains stable.',
    schema: renameFileSchema,
    handler: renameFile,
  }),
  tool({
    name: 'delete_file',
    description:
      "Delete a Google Drive file or folder. By default, moves to Trash (recoverable for 30 days). Set permanent=true to skip Trash. CAUTION: permanent deletion cannot be undone.",
    schema: deleteFileSchema,
    handler: deleteFile,
  }),
  tool({
    name: 'restore_file',
    description:
      'Restore a trashed file to its previous location. Only works for files in Trash, not permanently deleted ones.',
    schema: restoreFileSchema,
    handler: restoreFile,
  }),
  tool({
    name: 'list_folder',
    description:
      "List the contents of a Drive folder. Returns files and subfolders sorted folders-first, then alphabetically. Use folder_id='root' for My Drive.",
    schema: listFolderSchema,
    handler: listFolder,
  }),

  // ---- Docs ----
  tool({
    name: 'find_and_replace',
    description:
      'Find and replace text across a Google Doc. Returns the number of occurrences changed. Use this for renames, typo fixes, and text updates.',
    schema: findAndReplaceSchema,
    handler: findAndReplace,
  }),
  tool({
    name: 'append_to_doc',
    description:
      'Append text to the end of a Google Doc. By default adds two newlines of leading separation. Use this to add new entries to logs, journals, or running notes.',
    schema: appendToDocSchema,
    handler: appendToDoc,
  }),
  tool({
    name: 'insert_at_heading',
    description:
      "Insert content immediately after (or before) a specific heading in a Google Doc, identified by its exact text. Use this when content needs to land in a specific section.",
    schema: insertAtHeadingSchema,
    handler: insertAtHeading,
  }),
  tool({
    name: 'apply_text_style',
    description:
      'Apply text formatting (bold, italic, underline, strikethrough, font size, color) to all occurrences of given text in a Google Doc.',
    schema: applyTextStyleSchema,
    handler: applyTextStyle,
  }),

  // ---- Sheets ----
  tool({
    name: 'append_row',
    description:
      "Append a row of values to the bottom of a sheet tab. Use this for running logs (expense reports, time entries, etc.). Values can be strings, numbers, or booleans; formulas like '=SUM(A1:A10)' are supported with USER_ENTERED.",
    schema: appendRowSchema,
    handler: appendRow,
  }),
  tool({
    name: 'update_cell',
    description:
      "Set a single cell's value. Specify the range in A1 notation (e.g., 'Sheet1!B7'). For setting a 2D range, use update_range instead.",
    schema: updateCellSchema,
    handler: updateCell,
  }),
  tool({
    name: 'update_range',
    description:
      "Set values across a 2D range of cells. The values are a 2D array of rows × columns. Use this for bulk updates and matrix-style edits.",
    schema: updateRangeSchema,
    handler: updateRange,
  }),
  tool({
    name: 'find_and_replace_in_sheet',
    description:
      "Find and replace text across one or all sheets in a spreadsheet. Returns counts of occurrences/rows/sheets changed.",
    schema: findAndReplaceInSheetSchema,
    handler: findAndReplaceInSheet,
  }),
] as const;

// =========================================================================
// Server setup
// =========================================================================

const server = new Server(
  {
    name: 'armoryworks-drive-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, () => {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: 'jsonSchema7' }) as Record<string, unknown>,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = tools.find((t) => t.name === name);

  if (!def) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
    };
  }

  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Invalid arguments for ${name}: ${parsed.error.message}`,
        },
      ],
    };
  }

  // The handler signature is narrowed per-tool by its own ToolDef<T>, but the
  // union of all tool defs widens the parameter type to an impossible
  // intersection. Cast to a generic handler shape; the schema parse above
  // has already validated the input matches def.schema.
  const handler = def.handler as (input: unknown) => Promise<unknown>;
  const result = await wrapToolErrors(name, () => handler(parsed.data));

  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `[${result.error.code}] ${result.error.message}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result.value, null, 2),
      },
    ],
  };
});

// =========================================================================
// Bootstrap
// =========================================================================

async function main(): Promise<void> {
  // Fail fast if the user hasn't done the one-time OAuth setup.
  const authed = await hasValidAuth().catch(() => false);
  if (!authed) {
    process.stderr.write(
      `armoryworks-drive-mcp: no valid OAuth tokens found.\n` +
        `Run 'npx @armoryworks/drive-mcp auth' to complete one-time setup.\n` +
        `See README.md for instructions.\n`,
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`armoryworks-drive-mcp: fatal error: ${String(err)}\n`);
  process.exit(1);
});
