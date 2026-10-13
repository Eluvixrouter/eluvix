import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { evaluateMathExpression, isBlockedHost } from '@/lib/api-helpers';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    
    if (body.action === 'list') {
      return NextResponse.json({
        success: true,
        tools: [
          {
            name: "web_scraper",
            description: "Fetches and extracts raw text from a given URL.",
            schema: {
              url: "string (Required. The absolute URL to scrape)"
            }
          },
          {
            name: "calculator",
            description: "Evaluates basic mathematical expressions.",
            schema: {
              expression: "string (Required. Math expression e.g. '2 + 2 * 4')"
            }
          }
        ]
      });
    }

    if (body.action === 'execute') {
      const { tool, params } = body;

      if (!params || typeof params !== 'object') {
        return NextResponse.json({ success: false, error: "Missing or invalid tool parameters" }, { status: 400 });
      }
      
      if (tool === 'calculator') {
        if (typeof params.expression !== 'string' || !params.expression.trim()) {
          return NextResponse.json({ success: false, error: "expression string parameter is required" }, { status: 400 });
        }
        try {
          const result = evaluateMathExpression(params.expression);
          return NextResponse.json({ success: true, result });
        } catch (evalErr: any) {
          return NextResponse.json({ success: false, error: evalErr.message }, { status: 400 });
        }
      }

      if (tool === 'web_scraper') {
        if (typeof params.url !== 'string' || !params.url.trim()) {
          return NextResponse.json({ success: false, error: "url string parameter is required" }, { status: 400 });
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(params.url);
        } catch {
          return NextResponse.json({ success: false, error: "Invalid URL provided" }, { status: 400 });
        }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return NextResponse.json({ success: false, error: "Only http and https protocols are supported" }, { status: 400 });
        }

        if (isBlockedHost(parsedUrl.hostname)) {
          return NextResponse.json({ success: false, error: "Access to private, loopback, or metadata addresses is blocked" }, { status: 403 });
        }

        try {
          const res = await fetch(parsedUrl.toString(), {
            signal: AbortSignal.timeout(8000),
            headers: {
              'User-Agent': 'Eluvix-Scraper/1.0'
            }
          });

          if (!res.ok) {
            return NextResponse.json({ success: false, error: `Upstream web server returned status ${res.status}` }, { status: 502 });
          }

          const html = await res.text();
          // Super basic HTML tag stripper for the native tool
          const text = html.replace(/<[^>]*>?/gm, ' ').replace(/\s\s+/g, ' ').substring(0, 5000);
          return NextResponse.json({ success: true, result: text });
        } catch (fetchErr: any) {
          return NextResponse.json({ success: false, error: `Failed to scrape URL: ${fetchErr.message}` }, { status: 502 });
        }
      }

      return NextResponse.json({ success: false, error: "Unknown tool" }, { status: 404 });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
