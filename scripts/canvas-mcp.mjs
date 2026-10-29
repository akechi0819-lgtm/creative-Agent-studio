import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCompanyCanvasMcp } from '../src/canvas/mcp.mjs';

await createCompanyCanvasMcp().connect(new StdioServerTransport());
