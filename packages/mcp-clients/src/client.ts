export interface McpToolCall<TArguments = Record<string, unknown>> {
  server: string;
  tool: string;
  arguments: TArguments;
}

export interface McpToolResult<TResult = unknown> {
  ok: boolean;
  result?: TResult;
  error?: string;
}

export interface McpClient {
  call<TArguments, TResult>(call: McpToolCall<TArguments>): Promise<McpToolResult<TResult>>;
}
