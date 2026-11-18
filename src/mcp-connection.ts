export interface McpConnectionDetails {
  url: string;
  headers: {
    Authorization: string;
  };
}

export function maskAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? "Bearer ••••••••" : "••••••••";
}

export function formatMcpConnectionJson(
  connection: McpConnectionDetails,
  revealToken: boolean,
): string {
  const authorization = revealToken
    ? connection.headers.Authorization
    : maskAuthorizationHeader(connection.headers.Authorization);
  return JSON.stringify(
    {
      mcpServers: {
        "kordoc-obsidian": {
          url: connection.url,
          headers: {
            Authorization: authorization,
          },
        },
      },
    },
    null,
    2,
  );
}
