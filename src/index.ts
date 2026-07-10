import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({
  name: "FallbackAdvisor",
  title: "FallbackAdvisor",
  description: "",
  version: "0.0.0",
})

const zFallbackAdvisorInput = z.object({})
const zFallbackAdvisorOutput = z.object({})

server.registerTool(
  "FallbackAdvisor",
  {
    title: "FallbackAdvisor",
    description: "",
    inputSchema: zFallbackAdvisorInput,
    outputSchema: zFallbackAdvisorOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (_input: z.infer<typeof zFallbackAdvisorInput>) => {
    // 1. カレントディレクトリなどから、現在の ~/.claude/projects/ のうちどのjsonlがセッションの会話かどうか判定
    // 2. 会話データを読み込み、Claude Agent SDKの会話形式に変換、推論（advisor toolは使用しない。advisor相当のプロンプトはこちらで用意する。）
    // 3. 推論結果を返却

    const result = {} satisfies z.infer<typeof zFallbackAdvisorOutput>
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
      structuredContent: result,
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
