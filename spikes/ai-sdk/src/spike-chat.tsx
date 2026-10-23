// M0-4 spike client: useChat + DefaultChatTransport exactly as plan §5.3
// will use it in the side panel (bridge URL + Bearer token headers).
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

export interface SpikeChatProps {
  baseUrl: string;
  provider?: "mock-openai" | "anthropic";
  agentMode?: boolean;
}

export function SpikeChat({
  baseUrl,
  provider = "mock-openai",
  agentMode = false,
}: SpikeChatProps) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: `${baseUrl}/api/chat`,
      headers: { Authorization: "Bearer spike-token" },
      body: { provider, agentMode },
    }),
  });

  return (
    <div>
      <div data-testid="status">{status}</div>
      {error ? <div data-testid="error">{error.message}</div> : null}
      <div data-testid="messages">
        {messages.map((message) => (
          <div data-testid={`message-${message.role}`} key={message.id}>
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return (
                  <span data-testid="text-part" key={index}>
                    {part.text}
                  </span>
                );
              }
              if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                return (
                  <pre data-testid="tool-part" key={index}>
                    {JSON.stringify(part)}
                  </pre>
                );
              }
              return null;
            })}
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = input;
          setInput("");
          void sendMessage({ text });
        }}
      >
        <input
          aria-label="message"
          onChange={(event) => setInput(event.target.value)}
          value={input}
        />
        <button type="submit">send</button>
      </form>
    </div>
  );
}
