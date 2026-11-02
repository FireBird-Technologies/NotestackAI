import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiResourceMeta,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";

import { ApiError, api } from "../api/client";
import type { ExternalWidget } from "../api/types";

type WidgetResource = {
  resource_uri: string;
  html: string;
  mime_type: string;
  meta: McpUiResourceMeta;
};

const MIN_HEIGHT = 180;
const MAX_HEIGHT = 1100;

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as { type?: string; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** A standards-compliant MCP Apps host for UI resources returned by connected external tools. */
export function ExternalMcpApp({ widget, onMessage }: {
  widget: ExternalWidget;
  onMessage: (text: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AppBridge | null>(null);
  const messageHandler = useRef(onMessage);
  messageHandler.current = onMessage;
  const [resource, setResource] = useState<WidgetResource | null>(null);
  const [height, setHeight] = useState(420);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setResource(null);
    setError("");
    void api<WidgetResource>(
      `/api/outbound-mcp/connections/${widget.connection_id}/widgets/${encodeURIComponent(widget.tool)}`,
    ).then((value) => {
      if (!cancelled) setResource(value);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "The external widget could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [widget.connection_id, widget.tool, widget.resource_uri]);

  useEffect(() => () => {
    const current = bridge.current;
    bridge.current = null;
    if (current) void current.teardownResource({}).catch(() => current.close());
  }, []);

  const connect = useCallback(async () => {
    const iframe = frame.current;
    if (!iframe?.contentWindow || !resource) return;
    if (bridge.current) await bridge.current.close().catch(() => undefined);

    const appBridge = new AppBridge(
      null,
      { name: "Notestack", version: "1.0.0" },
      {
        openLinks: {},
        serverTools: {},
        logging: {},
        message: { text: {} },
      },
      {
        hostContext: {
          theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platform: "web",
          containerDimensions: { maxHeight: MAX_HEIGHT },
        },
      },
    );
    bridge.current = appBridge;

    appBridge.onsizechange = ({ height: nextHeight }) => {
      if (typeof nextHeight === "number" && Number.isFinite(nextHeight)) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(nextHeight))));
      }
    };
    appBridge.onopenlink = async ({ url }) => {
      try {
        const target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol)) return { isError: true };
        window.open(target.toString(), "_blank", "noopener,noreferrer");
        return {};
      } catch {
        return { isError: true };
      }
    };
    appBridge.onrequestdisplaymode = async () => ({ mode: "inline" });
    appBridge.onmessage = async ({ content }) => {
      const text = messageText(content);
      if (!text) return { isError: true };
      messageHandler.current(text);
      return {};
    };
    appBridge.oncalltool = async ({ name, arguments: args }) => {
      const call = async (approved: boolean) => api<CallToolResult>(
        `/api/outbound-mcp/connections/${widget.connection_id}/widgets/tools/${encodeURIComponent(name)}`,
        { method: "POST", body: JSON.stringify({ arguments: args ?? {}, approved }) },
      );
      try {
        return await call(false);
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== "confirmation_required") throw reason;
        const approved = window.confirm(`${reason.message}\n\nContinue?`);
        if (!approved) return { content: [{ type: "text", text: "The user cancelled this action." }], isError: true };
        return call(true);
      }
    };
    appBridge.oninitialized = () => {
      void appBridge.sendToolInput({ arguments: widget.arguments });
      void appBridge.sendToolResult(widget.result as CallToolResult);
    };
    appBridge.addEventListener("requestteardown", () => {
      void appBridge.teardownResource({}).catch(() => undefined);
    });

    try {
      await appBridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
    } catch (reason) {
      if (bridge.current === appBridge) {
        setError(reason instanceof Error ? reason.message : "The external widget could not start.");
      }
    }
  }, [resource, widget]);

  if (error) return <p className="external-widget-error muted small">{error}</p>;
  if (!resource) return <p className="external-widget-loading mono muted small">Loading {widget.connection} widget…</p>;

  return (
    <section className="external-widget" aria-label={`${widget.connection} ${widget.tool}`}>
      <iframe
        ref={frame}
        title={`${widget.connection}: ${widget.tool}`}
        srcDoc={resource.html}
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        allow={buildAllowAttribute(resource.meta?.permissions)}
        style={{ height }}
        onLoad={() => { void connect(); }}
      />
    </section>
  );
}
