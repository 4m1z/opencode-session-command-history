import { Rpc } from "@opencode/plugin/rpc"

export interface HistoryView {
  count: number
  text: string
  warning?: string
  items: { value: string; title: string; category: string; description: string; detail: string }[]
}

export const CommandHistory = Rpc.define({
  id: "command-history",
  events: {},
  methods: {
    history: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          count: { type: "integer" },
          text: { type: "string" },
          warning: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                value: { type: "string" }, title: { type: "string" }, category: { type: "string" },
                description: { type: "string" }, detail: { type: "string" },
              },
              required: ["value", "title", "category", "description", "detail"],
              additionalProperties: false,
            },
          },
        },
        required: ["count", "text", "items"],
        additionalProperties: false,
      },
    },
  },
})
