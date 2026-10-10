import "server-only";
import { delegateTool } from "../subagents";
import { calculatorTool } from "./calculator";
import { runCommandTool } from "./command";
import { editFileTool, listFilesTool, readFileTool, searchFilesTool, writeFileTool } from "./files";
import { gitDiffTool } from "./git-diff";
import { forgetMemoryTool, saveMemoryTool } from "./memory";
import { updatePlanTool } from "./plan";
import { currentTimeTool } from "./time";
import type { ToolDefinition } from "./types";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";

/** Built-in tools, in the order the settings page lists them. MCP tools are appended at run time. */
export const builtinTools = [
  updatePlanTool,
  delegateTool,
  listFilesTool,
  readFileTool,
  searchFilesTool,
  gitDiffTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  webSearchTool,
  webFetchTool,
  saveMemoryTool,
  forgetMemoryTool,
  calculatorTool,
  currentTimeTool,
] as unknown as ToolDefinition[];
