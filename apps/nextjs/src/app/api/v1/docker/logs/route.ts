import { NextRequest } from "next/server";
import { spawn } from "child_process";

import { isValidContainerName } from '@/lib/api-helpers';

export async function GET(req: NextRequest) {
  const container = req.nextUrl.searchParams.get("container");
  if (!container) {
    return new Response("Missing container parameter", { status: 400 });
  }

  const cleanContainer = container.trim().toLowerCase();
  if (!isValidContainerName(cleanContainer)) {
    return new Response("Invalid or disallowed container parameter", { status: 400 });
  }

  const encoder = new TextEncoder();
  const customReadable = new ReadableStream({
    start(controller) {
      const docker = spawn("docker", ["logs", "-f", "--tail", "50", `eluvix-${cleanContainer}`]);
      let closed = false;

      const safeClose = () => {
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* ignore */ }
        }
      };

      docker.stdout.on("data", (data) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data.toString())}\n\n`));
          } catch {
            safeClose();
          }
        }
      });

      docker.stderr.on("data", (data) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data.toString())}\n\n`));
          } catch {
            safeClose();
          }
        }
      });

      docker.on("close", () => {
        safeClose();
      });
      
      docker.on("error", (err) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify("Error: " + err.message)}\n\n`));
          } catch { /* ignore */ }
          safeClose();
        }
      });

      // Cleanup on disconnect or after 10m max streaming timeout
      const maxStreamTimer = setTimeout(() => {
        try { docker.kill(); } catch {}
        safeClose();
      }, 10 * 60 * 1000);

      req.signal.addEventListener("abort", () => {
        clearTimeout(maxStreamTimer);
        try { docker.kill(); } catch {}
        safeClose();
      });
    },
  });

  return new Response(customReadable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
