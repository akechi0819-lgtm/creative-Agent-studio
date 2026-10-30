import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCompanyMaterialsMcp } from '../src/materials/mcp.mjs';

await createCompanyMaterialsMcp().connect(new StdioServerTransport());
