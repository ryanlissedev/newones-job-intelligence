export const restBinding = (method: string, path: string) =>
  ({ operation: `${method} ${path}`, transport: "rest" }) as const;

export const mcpBinding = (toolName: string) =>
  ({ operation: toolName, transport: "mcp" }) as const;

export const dualBindings = (method: string, path: string, toolName: string) =>
  [restBinding(method, path), mcpBinding(toolName)] as const;
