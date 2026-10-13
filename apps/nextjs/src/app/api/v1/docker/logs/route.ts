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

      docker.stdout.on("data", (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data.toString())}\n\n`));
      });

      docker.stderr.on("data", (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data.toString())}\n\n`));
      });

      docker.on("close", () => {
        try { controller.close(); } catch { /* ignore */ }
      });
      
      docker.on("error", (err) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify("Error: " + err.message)}\n\n`));
          controller.close();
        } catch { /* ignore */ }
      });

      // Cleanup on disconnect
      req.signal.addEventListener("abort", () => {
        docker.kill();
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
